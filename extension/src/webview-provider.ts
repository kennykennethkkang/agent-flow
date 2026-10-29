import * as vscode from 'vscode'
import * as crypto from 'crypto'
import {
  ExtensionToWebviewMessage,
  WebviewToExtensionMessage,
  AgentEvent,
} from './protocol'
import {
  BRIDGE_INIT_MAX_RETRIES, BRIDGE_INIT_RETRY_MS, DEFAULT_DEV_PORT, NONCE_LENGTH, NONCE_CHARS,
  WEBVIEW_BG_COLOR, WEBVIEW_LOADING_TEXT, WEBVIEW_LOADING_TEXT_DIM,
} from './constants'

function getNonce(): string {
  const bytes = crypto.randomBytes(NONCE_LENGTH)
  const chars = NONCE_CHARS
  let text = ''
  for (let i = 0; i < NONCE_LENGTH; i++) {
    text += chars.charAt(bytes[i] % chars.length)
  }
  return text
}

function webviewOptions(extensionUri: vscode.Uri): vscode.WebviewOptions {
  return {
    enableScripts: true,
    localResourceRoots: [
      vscode.Uri.joinPath(extensionUri, 'dist'),
      vscode.Uri.joinPath(extensionUri, 'media'),
    ],
  }
}

/** The Switchboard UI in an editor tab; the Activity Bar view only opens one. */
export class VisualizerPanel implements vscode.Disposable {
  public static readonly viewType = 'agentVisualizer'
  public static readonly sidebarViewType = 'switchboard.view'
  /** The editor tab, revealed instead of opening a second one. */
  private static instance: VisualizerPanel | undefined
  /** Every open view. */
  private static readonly live = new Set<VisualizerPanel>()
  /** While set, only this view gets messages: a replay for a view that just opened must not repeat into the others. */
  private static replayTarget: VisualizerPanel | undefined

  private readonly panel: vscode.WebviewPanel | vscode.WebviewView
  private readonly extensionUri: vscode.Uri
  private readonly disposables: vscode.Disposable[] = []
  private readonly _onCommand = new vscode.EventEmitter<WebviewToExtensionMessage>()
  private _wired = false
  private _ready = false

  readonly onCommand = this._onCommand.event

  /** Returns true if wirePanel has already been called on this instance */
  get isWired(): boolean { return this._wired }
  markWired(): void { this._wired = true }

  /** Whether the webview has signaled 'ready' and replay is complete.
   *  Live events should be gated on this to prevent duplication with replay. */
  get isReady(): boolean { return this._ready }
  markReady(): void { this._ready = true }

  private constructor(panel: vscode.WebviewPanel | vscode.WebviewView, extensionUri: vscode.Uri) {
    this.panel = panel
    this.extensionUri = extensionUri
    VisualizerPanel.live.add(this)

    this.panel.webview.html = this.getHtml()

    // Listen for messages from the webview
    this.panel.webview.onDidReceiveMessage(
      (message: WebviewToExtensionMessage) => {
        this._onCommand.fire(message)
      },
      undefined,
      this.disposables,
    )

    // Cleanup on dispose
    this.panel.onDidDispose(
      () => this.dispose(),
      undefined,
      this.disposables,
    )
  }

  /** preserveFocus: a replacement opened in the background, which also leaves an existing tab where it is. */
  static create(extensionUri: vscode.Uri, column: vscode.ViewColumn, preserveFocus = false): VisualizerPanel {
    if (VisualizerPanel.instance) {
      if (!preserveFocus) (VisualizerPanel.instance.panel as vscode.WebviewPanel).reveal(column)
      return VisualizerPanel.instance
    }

    const panel = vscode.window.createWebviewPanel(
      VisualizerPanel.viewType,
      'Switchboard',
      { viewColumn: column, preserveFocus },
      { ...webviewOptions(extensionUri), retainContextWhenHidden: true },
    )

    panel.iconPath = {
      light: vscode.Uri.joinPath(extensionUri, 'media', 'icon-light.svg'),
      dark: vscode.Uri.joinPath(extensionUri, 'media', 'icon-dark.svg'),
    }

    VisualizerPanel.instance = new VisualizerPanel(panel, extensionUri)
    return VisualizerPanel.instance
  }

  /** The columns where an editor tab of this extension host is on screen. */
  static tabColumns(): number[] {
    return [...VisualizerPanel.live].flatMap(v => 'viewColumn' in v.panel && v.panel.visible && v.panel.viewColumn ? [v.panel.viewColumn] : [])
  }

  /** A restored tab; undefined, and the restored one closed, when the Activity Bar icon already opened a tab this start. */
  static revive(panel: vscode.WebviewPanel, extensionUri: vscode.Uri): VisualizerPanel | undefined {
    if (VisualizerPanel.instance) { panel.dispose(); return undefined }
    VisualizerPanel.instance = new VisualizerPanel(panel, extensionUri)
    return VisualizerPanel.instance
  }

  /** Every open view, or only the one being replayed to. */
  static all(): VisualizerPanel[] {
    return VisualizerPanel.replayTarget ? [VisualizerPanel.replayTarget] : [...VisualizerPanel.live]
  }

  /** The open views that finished their replay, for live events. */
  static ready(): VisualizerPanel[] {
    return VisualizerPanel.all().filter(p => p.isReady)
  }

  /** Runs a synchronous replay with every message going to this view only. */
  static replayTo(panel: VisualizerPanel, replay: () => void): void {
    VisualizerPanel.replayTarget = panel
    try { replay() } finally { VisualizerPanel.replayTarget = undefined }
  }

  /** Whether the view is on screen: false while the sidebar is collapsed or the tab is in the background. */
  get visible(): boolean { return this.panel.visible }

  /** Fires with the new visibility each time the view is hidden or shown. */
  onDidChangeVisible(listener: (visible: boolean) => void): void {
    const p = this.panel
    let last = p.visible
    const fire = () => { if (p.visible !== last) { last = p.visible; listener(last) } }
    this.disposables.push('onDidChangeVisibility' in p ? p.onDidChangeVisibility(fire) : p.onDidChangeViewState(fire))
  }

  /** Not kept in this.disposables: dispose() runs from the same event and would drop the listener before it fires. */
  onDidDispose(listener: () => void): void {
    this.panel.onDidDispose(listener)
  }

  /** Send a typed message to the webview (fails silently if panel is disposed) */
  postMessage(message: ExtensionToWebviewMessage): void {
    try {
      this.panel.webview.postMessage(message)
    } catch {
      // Panel may have been disposed between check and send — safe to ignore
    }
  }

  /** Send an agent event to the webview */
  sendEvent(event: AgentEvent): void {
    this.postMessage({ type: 'agent-event', event })
  }

  /** Update connection status display */
  setConnectionStatus(status: 'connected' | 'disconnected' | 'watching', source: string): void {
    this.postMessage({ type: 'connection-status', status, source })
  }

  private getHtml(): string {
    const isDev = this.isDevelopmentMode()

    if (isDev) {
      return this.getDevHtml()
    }
    return this.getProductionHtml()
  }

  private isDevelopmentMode(): boolean {
    // Only use dev mode if the user explicitly set a port in settings
    const config = vscode.workspace.getConfiguration('agentVisualizer')
    const port = config.get<number>('devServerPort', 0)
    return port > 0
  }

  private getDevHtml(): string {
    const config = vscode.workspace.getConfiguration('agentVisualizer')
    const port = config.get<number>('devServerPort', DEFAULT_DEV_PORT)
    const nonce = getNonce()

    // In dev mode, load the Next.js app via iframe
    // The bridge script in the iframe communicates with the parent via postMessage
    return `<!DOCTYPE html>
<html lang="en" style="height:100%; margin:0; padding:0;">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none';
      frame-src http://localhost:${port} https://localhost:${port};
      script-src 'nonce-${nonce}';
      style-src 'unsafe-inline';"
  />
  <style>
    html, body { height: 100%; margin: 0; padding: 0; overflow: hidden; background: ${WEBVIEW_BG_COLOR}; }
    iframe { width: 100%; height: 100%; border: none; }
    .connecting {
      position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%);
      font-family: 'SF Mono', 'Fira Code', monospace; font-size: 12px;
      color: ${WEBVIEW_LOADING_TEXT}; text-align: center;
    }
    .connecting .dot { animation: pulse 1.5s infinite; }
    @keyframes pulse { 0%, 100% { opacity: 0.3; } 50% { opacity: 1; } }
  </style>
</head>
<body>
  <div class="connecting" id="loading">
    <div>CONNECTING TO DEV SERVER</div>
    <div class="dot" style="margin-top: 8px;">●</div>
    <div style="margin-top: 8px; font-size: 10px; color: ${WEBVIEW_LOADING_TEXT_DIM};">localhost:${port}</div>
  </div>
  <iframe id="app-frame" src="http://localhost:${port}" style="display:none;"></iframe>
  <script nonce="${nonce}">
    (function() {
      const vscode = acquireVsCodeApi();
      const iframe = document.getElementById('app-frame');
      const loading = document.getElementById('loading');
      let iframeReady = false;
      let pendingMessages = [];

      // Show iframe once loaded, then keep sending bridge-init until acked
      iframe.addEventListener('load', () => {
        loading.style.display = 'none';
        iframe.style.display = 'block';

        // The React app may not have mounted yet, so retry the init message
        let initAttempts = 0;
        const initInterval = setInterval(() => {
          if (iframeReady || initAttempts > ${BRIDGE_INIT_MAX_RETRIES}) {
            clearInterval(initInterval);
            return;
          }
          iframe.contentWindow.postMessage({ type: '__vscode-bridge-init', source: 'extension' }, '*');
          initAttempts++;
        }, ${BRIDGE_INIT_RETRY_MS});
      });

      // Single unified message handler
      window.addEventListener('message', (e) => {
        if (e.source === iframe.contentWindow) {
          // Message from iframe → forward to extension host
          if (e.data && e.data.type === 'ready') {
            iframeReady = true;
            // Flush any pending messages
            for (const msg of pendingMessages) {
              iframe.contentWindow.postMessage(msg, '*');
            }
            pendingMessages = [];
          }
          vscode.postMessage(e.data);
        } else {
          // Message from extension host → forward to iframe
          if (iframeReady) {
            iframe.contentWindow.postMessage(e.data, '*');
          } else {
            pendingMessages.push(e.data);
          }
        }
      });

      // Tell extension we're ready (outer frame ready, not iframe)
      vscode.postMessage({ type: 'ready' });
    })();
  </script>
</body>
</html>`
  }

  private getProductionHtml(): string {
    const webview = this.panel.webview
    const nonce = getNonce()

    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview', 'index.js'),
    )
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview', 'index.css'),
    )

    return `<!DOCTYPE html>
<html lang="en" class="dark" style="height:100%; margin:0; padding:0;">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none';
      style-src ${webview.cspSource} 'unsafe-inline';
      img-src ${webview.cspSource} https: data:;
      font-src ${webview.cspSource} data:;
      script-src 'nonce-${nonce}';"
  />
  <link rel="stylesheet" href="${styleUri}">
  <style>
    html, body { margin: 0; padding: 0; background: ${WEBVIEW_BG_COLOR}; }
  </style>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`
  }

  dispose(): void {
    if (VisualizerPanel.instance === this) VisualizerPanel.instance = undefined
    VisualizerPanel.live.delete(this)
    for (const d of this.disposables) {
      d.dispose()
    }
    this.disposables.length = 0
    this._onCommand.dispose()
  }
}
