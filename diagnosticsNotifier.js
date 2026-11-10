import {startDiagnosticMonitor} from "bargaz/diagnosticMonitor.js";
import {isShutdownRequested} from "bargaz/shutdownCoordinator.js";
import {getOwnerChannel} from "./owner.js";

const ISSUE_NAMES = {
  diagnostics_unavailable: "System diagnostics are unavailable or stale.",
  low_space: "Available storage is below the warning threshold.",
  low_inodes: "Available filesystem inodes are below the warning threshold.",
  filesystem_error: "The kernel reported a filesystem error or warning.",
  storage_io_error: "The kernel reported a storage I/O error.",
  read_only_filesystem: "The kernel reported a read-only filesystem remount."
};

let monitor = null;

function describeIssue(issue) {
  if (ISSUE_NAMES[issue]) {
    return ISSUE_NAMES[issue];
  }

  if (issue.startsWith("check_failed:")) {
    return `Component check failed: ${issue.slice("check_failed:".length)}.`;
  }

  if (issue.startsWith("check_unavailable:")) {
    return `Check unavailable: ${issue.slice("check_unavailable:".length)}.`;
  }

  return issue;
}

export function startDiagnosticsNotifier() {
  if (monitor || isShutdownRequested()) {
    return;
  }

  monitor = startDiagnosticMonitor({
    url: process.env.BARGAZ_DIAGNOSTICS_URL ||
      "http://127.0.0.1:3001/endpoints/diagnostics",

    async onAlert({recovered, issues}) {
      if (isShutdownRequested()) {
        return;
      }

      const channel = await getOwnerChannel("errors");

      if (!channel) {
        throw new Error("The owner errors channel is unavailable.");
      }

      const content = recovered
        ? "🟢 **Bargaz system diagnostics recovered.**"
        : "🔴 **Bargaz system diagnostic alert**\n" +
          issues.map(issue => `- ${describeIssue(issue)}`).join("\n");

      await channel.send({
        content: content.slice(0, 1900),
        allowedMentions: {parse: []}
      });
    }
  });
}

export async function stopDiagnosticsNotifier() {
  if (!monitor) {
    return;
  }

  const current = monitor;
  monitor = null;
  await current.stop();
}