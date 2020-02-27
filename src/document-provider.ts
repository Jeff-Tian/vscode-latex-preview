import * as constants from "./constants";
import * as synctex from "./synctex";
import * as cp from "child_process";
import { mkdir } from "fs";
import * as http from "http";
import { dirname, join, relative, basename, parse } from "path";
import * as tmp from "tmp";
import * as vscode from "vscode";
import * as ws from "ws";

/**
 * Provides preview content and creates a websocket server which communicates with the preview.
 */
export default class LatexDocumentProvider implements vscode.TextDocumentContentProvider {
  public http: http.Server;
  public server: ws.Server;
  private listening: Promise<void>;

  private directories = new Map<string, string>();
  private clients = new Map<string, ws>();
  private connected = new Map<string, Promise<void>>();
  private connectedResolve = new Map<string, Function>();

  private diagnostics: vscode.DiagnosticCollection;
  private output: vscode.OutputChannel;

  constructor(private context: vscode.ExtensionContext) {
    this.http = http.createServer();
    this.server = ws.createServer({ server: this.http });

    this.listening = new Promise((c, e) => {
      this.http.listen(0, "localhost", undefined, err => err ? e(err) : c());
    });

    this.server.on("connection", client => {
      client.on("message", this.onClientMessage.bind(this, client));
      client.on("close", this.onClientClose.bind(this, client));
    });

    this.diagnostics = vscode.languages.createDiagnosticCollection("LaTeX Preview");
    this.output = vscode.window.createOutputChannel("LaTeX Preview");
  }

  public dispose() {
    this.server.close();

    this.diagnostics.dispose();
    this.output.dispose();
  }

  /**
   * Returns true if a client with the specified path is connected.
   */
  public isPreviewing(path: string): boolean {
    return this.clients.has(path);
  }

  /**
   * Creates a working dir and returns client HTML.
   */
  public async provideTextDocumentContent(uri: vscode.Uri, webview: any): Promise<string> {
    await this.listening;

    // Create a working dir and start listening.
    const path = uri.fsPath;

    this.directories.set(path, await this.createTempDir(path));
    this.listenForConnection(path);

    // Generate the document content.
    const { address, port } = this.http.address();
    const ws = `ws://${address}:${port}`;

    return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta
        http-equiv="Content-Security-Policy"
        content="default-src 'none'; img-src ${webview.cspSource} https:; script-src ${webview.cspSource}; style-src ${webview.cspSource};"
      />
      <link rel="stylesheet" href="${this.getResourcePath("media/style.css")}">

      <script src="${this.getResourcePath("node_modules/pdfjs-dist/build/pdf.js")}"></script>
      <script src="${this.getResourcePath("node_modules/pdfjs-dist/build/pdf.worker.js")}"></script>
      <script src="${this.getResourcePath("out/src/client.js")}"></script>
    </head>
    <body class="preview" data-path="${attr(path)}" data-websocket="${attr(ws)}">
      <div id="zoom">
        <span class="icon">🔎</span>
        <input id="zoom-input" type="number" value="100" min="0" />
        <button id="zoom-in">➕</a>
        <button id="zoom-out">➖</a>
      </div>

      <div id="compile-error">
        ⚠ error compiling preview
      </div>
      <iframe id="preview-panel" class="preview-panel" src="${uri.fsPath.replace('.tex', '.pdf')}" style="position:absolute; border: none; left: 0; top: 0; width: 100%; height: 100%;">
        Hello
            </iframe>
        Done: ${this.getResourcePath("out/src/client.js")} ${uri.fsPath}
    </body>
    </html>`;
  }

  public update(uri: vscode.Uri) {
    let paths: string[];

    if (vscode.workspace.getConfiguration().get<boolean>("true")) {
      paths = Array.from(this.clients.keys());
    } else {
      paths = [uri.fsPath];
    }

    paths.forEach(path => {
      this
        .build(path, this.directories.get(path))
        .then(pdf => {
          console.log('pdf = ', pdf);

          return ({ type: "update", path: pdf });
        })
        .catch((err) => {
          return ({ type: "error" });
        })
        .then(data => {
          console.log('data = ', data);
          return this.clients.get(path).send(JSON.stringify(data))
        });
    });
  }

  /**
   * Shows a text editor position in the preview.
   */
  public async showPosition(uri: vscode.Uri, position: vscode.Position) {
    const path = uri.fsPath;

    if (!this.isPreviewing(path)) {
      await vscode.commands.executeCommand("latex-preview.showPreview", uri);
    }

    // Make sure the client is connected.
    await this.connected.get(path);

    // Get the position and send to the client.
    const rects = await synctex.view({
      line: position.line + 1,
      column: position.character + 1,
      input: path,
      output: `${this.directories.get(path)}/preview.pdf`,
    });

    if (rects.length === 0) {
      return;
    }

    this.clients.get(path).send(JSON.stringify({ type: "show", rect: rects[0] }));
  }

  public showOutputChannel() {
    this.output.show();
  }

  /**
   * Builds a PDF and returns the path to it.
   */
  private build(path: string, dir: string): Promise<string> {
    const buildWith = "latexmk";
    const buildArgs = ["-xelatex", "-shell-escape", "-interaction=nonstopmode", "-file-line-error", parse(path).name]
    this.output.clear();
    const command = [buildWith].concat(buildArgs).join(" ");
    this.output.appendLine(command);
    console.log(command);

    return new Promise((resolve, reject) => {
      let env = Object.assign({}, process.env, { "OUTPUTDIR": arg(dir) });

      const latexmk = cp.spawn(buildWith, buildArgs, { cwd: dirname(path), env: env });

      this.diagnostics.clear();
      const error = [];

      latexmk.stdout.on('data', data => {
        console.log('latexmk: ', data.toString());
        this.output.append(data.toString());
      })

      latexmk.stderr.on('data', data => {
        console.error('latexmk: ', data.toString());
        this.output.append(data.toString());

        error.push(data.toString());
      });

      latexmk.on('close', (code) => {
        if (code !== 0) {
          console.error('latexmk exited with ', code);

          let regexp = new RegExp(constants.ERROR_REGEX, "gm");
          let entries = [];
          let matches: RegExpExecArray;

          while ((matches = regexp.exec(this.output.toString())) != null) {
            const line = parseInt(matches[2], 10) - 1;
            const range = new vscode.Range(line, 0, line, Number.MAX_VALUE);

            entries.push([
              vscode.Uri.file(matches[1]),
              [new vscode.Diagnostic(range, matches[3], vscode.DiagnosticSeverity.Error)],
            ]);
          }

          this.diagnostics.set(entries);

          reject({ code: code, messages: error.join('') });
        } else {
          console.error('latexmk finished with ', code);

          resolve(`${dir}/preview.pdf`);
        }
      })
    });
  }

  private listenForConnection(path: string) {
    this.connected.set(path, new Promise(resolve => {
      this.connectedResolve.set(path, resolve);
    }));
  }

  private onClientMessage(client: ws, message: any) {
    const data = JSON.parse(message);
    console.log('message from client: ', data);

    if (data.type === "open") {
      const path = data.path;

      this.clients.set(path, client);
      this.connectedResolve.get(path)();

      this.update(vscode.Uri.file(path));
    }

    if (data.type === "click") {
      this.onClientClick(client, data);
    }

    if (data.type === "showOutput") {
      this.showOutputChannel();
    }
  }

  private async onClientClick(client: ws, data: any) {
    const path = this.getPathForClient(client);
    const file = `${this.directories.get(path)}/preview.pdf`;

    const location = await synctex.edit(Object.assign(data, { file }));

    if (!location) {
      return;
    }

    const character = (location.column > 0) ? location.column - 1 : 0;
    const position = new vscode.Position(location.line - 1, character);

    const document = await vscode.workspace.openTextDocument(location.input);
    const editor = await vscode.window.showTextDocument(document);
    editor.selection = new vscode.Selection(position, position);
  }

  private onClientClose(closed: ws) {
    const path = this.getPathForClient(closed);

    this.clients.delete(path);
    this.listenForConnection(path);
  }

  private getPathForClient(client: ws): string {
    for (const [path, candidate] of this.clients.entries()) {
      if (client === candidate) {
        return path;
      }
    }
  }

  /**
   * Creates a new temporary directory.
   */
  private async createTempDir(target: string): Promise<string> {
    const dir = await new Promise<string>((c, e) =>
      tmp.dir({ unsafeCleanup: true }, (err, path) => err ? e(err) : c(path))
    );

    const wd = dirname(vscode.workspace.asRelativePath(target));
    const texs = await vscode.workspace.findFiles(join(wd, '**/*.tex'), "");

    const mkdirs = new Set(
      texs.map(file => dirname(file.fsPath))
        .map(dir => relative(dirname(target), dir))
        .filter(dir => !!dir)
        .sort((a, b) => a.length - b.length)
    );

    await Promise.all([...mkdirs].map(subdir => new Promise((c, e) => {
      mkdir(join(dir, subdir), err => err ? e(err) : c())
    })));

    return dir;
  }

  private getResourcePath(file: string): string {
    return this.context.asAbsolutePath(file);
  }
}

function arg(str: string): string {
  return '"' + str.replace(/([\\"$])/g, "\\$1") + '"';
}

function attr(str: string): string {
  return str.replace("&", "&amp;").replace('"', "&quot;");
}
