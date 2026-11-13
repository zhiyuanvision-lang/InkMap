import { App } from "@modelcontextprotocol/ext-apps";
import { OpenAIExtensions, OpenAIFileEntrypointInputSchema } from "@openai/mcp-extensions/app";
import { CodexHost } from "./codex-host";
import { mount } from "./main";
import { sidebarGate, sidebarText } from "./sidebar-shell";

const gate = sidebarGate(sidebarText("正在连接 Codex 文件面板…", "Connecting to the Codex file panel…"));
const app = new App({ name: "Inkmap", version: "0.1.0" }, {}, { autoResize: false });
const extensions = new OpenAIExtensions(app);
const connected = app.connect.bind(app);
let opened = false;
let ready: Promise<void>;
app.addEventListener("toolinput", async ({ arguments: args }) => {
  if (opened) return;
  const input = OpenAIFileEntrypointInputSchema.safeParse(args);
  if (!input.success || !/\.md$/i.test(input.data.file.name)) {
    gate.note.textContent = sidebarText("请在 Codex 文件面板中用 Inkmap 打开 Markdown 文件。", "Open a Markdown file with Inkmap from the Codex file panel.");
    return;
  }
  opened = true;
  try {
    await ready;
    if (!extensions.resources) throw new Error(sidebarText("当前客户端未提供文件面板接口。", "This client does not expose the file panel API."));
    gate.close();
    await mount(new CodexHost(app, extensions.resources, input.data.file));
  } catch (error) {
    if (!gate.panel.isConnected) sidebarGate(String(error instanceof Error ? error.message : error));
    else gate.note.textContent = String(error instanceof Error ? error.message : error);
  }
});
ready = connected();
void ready.then(() => {
  if (!opened) gate.note.textContent = sidebarText("请在 Codex 文件面板中用 Inkmap 打开 Markdown 文件。", "Open a Markdown file with Inkmap from the Codex file panel.");
}, () => {
  gate.note.textContent = sidebarText("无法连接 Codex 文件面板。", "Could not connect to the Codex file panel.");
});
