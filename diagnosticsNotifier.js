import {startDiagnosticMonitor} from "bargaz/diagnosticMonitor.js";
import {isShutdownRequested} from "bargaz/shutdownCoordinator.js";
import {getOwnerChannel, broadcastAlert} from "./owner.js";

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

export function startDiagnosticsNotifier(client = null) {
  if (monitor || isShutdownRequested()) {
    return;
  }

  monitor = startDiagnosticMonitor({
    url: process.env.BARGAZ_DIAGNOSTICS_URL ||
      "http://127.0.0.1:3001/endpoints/diagnostics",

    async onAlert({recovered, issues}) {
      if (isShutdownRequested()) {return;}

      const channel = await getOwnerChannel("errors");
      const content = recovered
        ? "🟢 **Bargaz system diagnostics recovered.**"
        : "🔴 **Bargaz system diagnostic alert**\n" +
          issues.map(issue => `- ${describeIssue(issue)}`).join("\n");

      if (channel) {
        await channel.send({content: content.slice(0, 1900), allowedMentions: {parse: []}}).catch(() => {});
      }

      await broadcastAlert(client, {
        title: recovered ? "System diagnostics recovered" : "System diagnostic alert",
        description: recovered ? "Bargaz system diagnostics recovered." : issues.map(issue => `- ${describeIssue(issue)}`).join("\n").slice(0, 4096),
        color: recovered ? 0x57F287 : 0xED4245
      }).catch(() => {});
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
