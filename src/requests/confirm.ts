export type Decision = "approve" | "reject" | "timeout";
export type Confirm = (title: string, text: string, timeoutSec: number) => Promise<Decision>;

/**
 * Command for a native Yes/No dialog. Title and text are read from the DIALOG_TITLE and
 * DIALOG_TEXT env vars, so symbols or reasons can't break the script's quoting.
 */
export function dialogCommand(platform: string, timeoutSec: number): string[] {
  const secs = Math.max(1, Math.floor(timeoutSec));
  if (platform === "win32") {
    // 4 Yes/No + 48 warning icon + 256 second button (No) is default + 4096 topmost.
    // Prints 6 for Yes, 7 for No, -1 on timeout.
    return [
      "powershell.exe",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `(New-Object -ComObject WScript.Shell).Popup($env:DIALOG_TEXT, ${secs}, $env:DIALOG_TITLE, 4 + 48 + 256 + 4096)`,
    ];
  }
  if (platform === "darwin") {
    return [
      "osascript",
      "-e",
      `set r to display dialog (system attribute "DIALOG_TEXT") with title (system attribute "DIALOG_TITLE") buttons {"Reject", "Approve"} default button "Reject" with icon caution giving up after ${secs}`,
      "-e",
      'if gave up of r then return "timeout"',
      "-e",
      "return button returned of r",
    ];
  }
  throw new Error(`No approval dialog for platform ${platform}; requests can only be approved on Windows or macOS`);
}

const ANSWERS: Record<string, Record<string, Decision>> = {
  win32: { "6": "approve", "7": "reject", "-1": "timeout" },
  darwin: { Approve: "approve", Reject: "reject", timeout: "timeout" },
};

export function parseDecision(platform: string, exitCode: number, stdout: string, stderr: string): Decision {
  const decision = exitCode === 0 ? ANSWERS[platform]?.[stdout.trim()] : undefined;
  if (decision) return decision;
  throw new Error(`Approval dialog failed (exit ${exitCode}): ${(stderr || stdout).trim().slice(0, 300)}`);
}

export const confirm: Confirm = async (title, text, timeoutSec) => {
  const proc = Bun.spawn(dialogCommand(process.platform, timeoutSec), {
    env: { ...process.env, DIALOG_TITLE: title, DIALOG_TEXT: text },
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return parseDecision(process.platform, code, stdout, stderr);
};
