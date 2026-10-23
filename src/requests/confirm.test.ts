import { expect, test } from "bun:test";
import { dialogCommand, parseDecision } from "./confirm.ts";

test("windows uses a topmost WScript popup with No as default, reading text from env", () => {
  const cmd = dialogCommand("win32", 95.7);
  expect(cmd.slice(0, 4)).toEqual(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command"]);
  expect(cmd[4]).toBe(
    "(New-Object -ComObject WScript.Shell).Popup($env:DIALOG_TEXT, 95, $env:DIALOG_TITLE, 4 + 48 + 256 + 4096)",
  );
});

test("macOS uses display dialog with Reject as default and a give-up timeout", () => {
  const script = dialogCommand("darwin", 120).join(" ");
  expect(script.startsWith("osascript -e ")).toBe(true);
  expect(script).toContain('display dialog (system attribute "DIALOG_TEXT")');
  expect(script).toContain('with title (system attribute "DIALOG_TITLE")');
  expect(script).toContain('buttons {"Reject", "Approve"} default button "Reject"');
  expect(script).toContain("giving up after 120");
});

test("timeouts are whole seconds, at least 1", () => {
  expect(dialogCommand("darwin", 0.4).join(" ")).toContain("giving up after 1");
});

test("other platforms have no dialog", () => {
  expect(() => dialogCommand("linux", 60)).toThrow("No approval dialog for platform linux");
});

test("maps dialog output to a decision", () => {
  expect(parseDecision("win32", 0, "6\r\n", "")).toBe("approve");
  expect(parseDecision("win32", 0, "7\r\n", "")).toBe("reject");
  expect(parseDecision("win32", 0, "-1\r\n", "")).toBe("timeout");
  expect(parseDecision("darwin", 0, "Approve\n", "")).toBe("approve");
  expect(parseDecision("darwin", 0, "Reject\n", "")).toBe("reject");
  expect(parseDecision("darwin", 0, "timeout\n", "")).toBe("timeout");
});

test("anything unexpected is an error, never an approval", () => {
  expect(() => parseDecision("win32", 1, "", "COM failure")).toThrow("Approval dialog failed (exit 1): COM failure");
  expect(() => parseDecision("win32", 0, "1\r\n", "")).toThrow("Approval dialog failed");
  expect(() => parseDecision("darwin", 0, "6\n", "")).toThrow("Approval dialog failed");
});
