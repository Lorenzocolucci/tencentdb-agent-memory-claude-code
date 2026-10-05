/**
 * Live 05/10/2026, two false alarms on the tool path:
 * - head "powershell -noprofile -command" tied a process listing to a past Junction failure;
 * - a lesson learned the user's own denial as if it were a tool error.
 */
import { describe, it, expect } from "vitest";
import { commandHeadOfRaw } from "../pretool-match.js";
import { isUserDenial, learnToolLesson } from "../tool-lessons.js";

describe("a shell launcher is not the command", () => {
  it("uses the inner command after powershell / cmd / bash flags", () => {
    const junction = commandHeadOfRaw('powershell -NoProfile -Command "New-Item -ItemType Junction -Path node_modules"');
    const listing = commandHeadOfRaw('powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter x"');
    expect(junction).toBe("new-item -itemtype junction");
    expect(listing).not.toBe(junction);
    expect(commandHeadOfRaw("cmd /c npm run build")).toBe("npm run build");
    expect(commandHeadOfRaw("bash -c 'git push -u fork'")).toBe("git push -u");
  });
  it("a script run with -File keeps the script as head; plain commands are unchanged", () => {
    expect(commandHeadOfRaw("powershell -File stop-gateway.ps1")).toBe("powershell -file stop-gateway.ps#");
    expect(commandHeadOfRaw("npm run build")).toBe("npm run build");
    expect(commandHeadOfRaw('powershell -NoProfile -Command "ls"')).toBeNull();
  });
});

describe("the user saying no is not a tool mistake", () => {
  it("denials are recognized and never learned", () => {
    expect(isUserDenial("The user doesn't want to proceed with this tool use. The tool use was rejected")).toBe(true);
    expect(isUserDenial("Exit code 143")).toBe(false);
    const denial = "Bash failed on `rm -rf dist`: The user doesn't want to proceed with this tool use.";
    expect(learnToolLesson({ id: "l", domain: "user interaction", text: "t", evidenceCount: 2 }, [denial, denial])).toBeNull();
  });
});
