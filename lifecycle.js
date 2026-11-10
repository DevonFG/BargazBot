import {isShutdownRequested} from "bargaz/shutdownCoordinator.js";

const activeTasks = new Set();

async function rejectNewWork(interaction) {
  if (
    !interaction?.isRepliable?.() ||
    interaction.replied ||
    interaction.deferred
  ) {
    return;
  }

  await interaction.reply({
    content: "BargazBot is shutting down. Please try again later.",
    flags: 64
  }).catch(() => {});
}

export function trackBotCallback(handler) {
  return (...args) => {
    if (isShutdownRequested()) {
      return rejectNewWork(args[0]);
    }

    const task = Promise.resolve().then(() => {
      if (isShutdownRequested()) {
        return rejectNewWork(args[0]);
      }

      return handler(...args);
    });

    activeTasks.add(task);

    task.then(
      () => activeTasks.delete(task),
      error => {
        activeTasks.delete(task);
        console.error("BargazBot callback failed:", error);
      }
    );

    return task;
  };
}

export async function drainBotTasks() {
  while (activeTasks.size > 0) {
    await Promise.allSettled([...activeTasks]);
  }
}