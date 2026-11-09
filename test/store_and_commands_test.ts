import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { parseCommands } from "../src/commands.ts";
import { form, readForm } from "../src/messages.ts";
import { Secret } from "../src/serve/secret.ts";
import { EncryptedFileStore } from "../src/store.ts";
import { ACCESS_TOKEN, REFRESH_TOKEN } from "./mock_serve.ts";

const KEY = new Secret(btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))));

Deno.test("the encrypted store keeps tokens across a restart, and never writes them in the clear", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const store = await EncryptedFileStore.open(`${dir}/state`, KEY);
    await store.putLink({
      teamId: "T1",
      userId: "U1",
      delegationId: "dlg-1",
      accessToken: new Secret(ACCESS_TOKEN),
      accessTokenExpiresAt: "2026-11-09T21:00:00.000Z",
      refreshToken: new Secret(REFRESH_TOKEN),
      linkedAt: "2026-11-09T20:00:00.000Z",
    });
    const raw = new TextDecoder("latin1").decode(await Deno.readFile(`${dir}/state/store.enc`));
    assert(!raw.includes(ACCESS_TOKEN) && !raw.includes("dlg-1"));
    assertEquals((await Deno.stat(`${dir}/state`)).mode! & 0o777, 0o700);
    assertEquals((await Deno.stat(`${dir}/state/store.enc`)).mode! & 0o777, 0o600);

    const again = await EncryptedFileStore.open(`${dir}/state`, KEY);
    const link = await again.getLink({ teamId: "T1", userId: "U1" });
    assertEquals(link?.accessToken.reveal(), ACCESS_TOKEN);
    assertEquals(link?.refreshToken.reveal(), REFRESH_TOKEN);

    const wrongKey = new Secret(btoa(String.fromCharCode(...new Uint8Array(32))));
    const error = await assertRejects(() => EncryptedFileStore.open(`${dir}/state`, wrongKey));
    assertStringIncludes((error as Error).message, "isn't the key it was written with");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a short store key is refused", async () => {
  await assertRejects(
    () => EncryptedFileStore.open("/nonexistent", new Secret(btoa("short"))),
    Error,
    "32 bytes",
  );
});

Deno.test("the commands file reports every problem at once", () => {
  const error = assertThrows(() =>
    parseCommands(`
ceiling:
  - actions: [run, delete]
    resource: "model:x"
commands:
  - command: /slackwater
    workflow: x
    description: clashes
  - command: Bad
    description: no workflow
    fields:
      - name: pick
        type: select
`)
  );
  const text = (error as Error).message;
  for (
    const problem of [
      'unknown action "delete"',
      "resource must look like workflow:",
      "clashes with /slackwater",
      "command must be a slash",
      "workflow is required",
      "a select needs options",
    ]
  ) assertStringIncludes(text, problem);
});

Deno.test("the demo commands file is valid, and its form reads back into inputs", async () => {
  const file = parseCommands(
    await Deno.readTextFile(new URL("../demo/commands.yaml", import.meta.url)),
  );
  const command = file.commands.find((c) => c.command === "/scale-web")!;
  const view = form(command, { command: command.command, channel: "C1" });
  assertEquals(view.type, "modal");
  const values = Object.fromEntries(command.fields.map((f) => [
    f.name,
    {
      value: f.type === "select"
        ? { selected_option: { value: f.options![0].value } }
        : { value: f.type === "number" ? String(f.min ?? 1) : "testing" },
    },
  ]));
  const read = readForm(command, values);
  assert("inputs" in read, JSON.stringify(read));
});

Deno.test("demo/manifest.json is up to date with demo/commands.yaml", async () => {
  const { buildManifest } = await import("../scripts/manifest.ts");
  const file = parseCommands(
    await Deno.readTextFile(new URL("../demo/commands.yaml", import.meta.url)),
  );
  const committed = JSON.parse(
    await Deno.readTextFile(new URL("../demo/manifest.json", import.meta.url)),
  );
  assertEquals(
    committed,
    buildManifest(file),
    "run: deno task manifest demo/commands.yaml > demo/manifest.json",
  );
  assert(!JSON.stringify(committed.display_information).toLowerCase().includes("slack"));
});

Deno.test("the app's own command is /slackwater unless the file names another", () => {
  const base = `ceiling:\n  - actions: [run]\n    resource: "workflow:x"\ncommands: []\n`;
  assertEquals(parseCommands(base).appCommand, "/slackwater");
  assertEquals(parseCommands(`appCommand: /ops\n${base}`).appCommand, "/ops");
  assertThrows(() => parseCommands(`appCommand: ops\n${base}`), Error, "appCommand must be");
});

Deno.test("the app is called Swamp and mentioned as @slackwater, and Slack's naming rule is checked", () => {
  const base = `ceiling:\n  - actions: [run]\n    resource: "workflow:x"\ncommands: []\n`;
  const file = parseCommands(base);
  assertEquals([file.appName, file.botName], ["Swamp", "slackwater"]);
  assertThrows(
    () => parseCommands(`appName: Slackwater\n${base}`),
    Error,
    'can\'t contain "Slack"',
  );
});
