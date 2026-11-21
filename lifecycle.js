import * as appLogger from "./appLogger.js";
import {isShutdownRequested} from "bargaz/shutdownCoordinator.js";

const activeTasks = new Set();
const trackedTimers = new Set();

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

function registerTask(task, label) {
  activeTasks.add(task);
  task.then(
    () => activeTasks.delete(task),
    error => {
      activeTasks.delete(task);
      appLogger.error("BargazBot background task failed:", label, error);
    }
  );
  return task;
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

    return registerTask(task, "event callback");
  };
}

export function trackBackgroundTask(promise, label = "background task") {
  if (isShutdownRequested()) {
    Promise.resolve(promise).catch(() => {});
    return Promise.resolve();
  }
  return registerTask(Promise.resolve(promise), label);
}

export function trackInterval(callback, ms, label = "interval") {
  if (isShutdownRequested()) {return null;}
  const entry = {type: "interval", label, handle: null};
  const wrapped = trackBotCallback(() => callback());
  entry.handle = setInterval(wrapped, ms);
  trackedTimers.add(entry);
  return entry.handle;
}

export function trackTimeout(callback, ms, label = "timeout") {
  if (isShutdownRequested()) {return null;}
  const entry = {type: "timeout", label, handle: null};
  const wrapped = trackBotCallback(() => callback());
  entry.handle = setTimeout(() => {
    trackedTimers.delete(entry);
    wrapped();
  }, ms);
  trackedTimers.add(entry);
  return entry.handle;
}

export function clearTrackedTimer(handle) {
  for (const entry of trackedTimers) {
    if (entry.handle !== handle) {continue;}
    if (entry.type === "interval") {clearInterval(handle);} else {clearTimeout(handle);}
    trackedTimers.delete(entry);
    return true;
  }
  clearInterval(handle);
  clearTimeout(handle);
  return false;
}

export function stopTrackedTimers() {
  let stopped = 0;
  for (const entry of trackedTimers) {
    if (entry.type === "interval") {clearInterval(entry.handle);} else {clearTimeout(entry.handle);}
    stopped++;
  }
  trackedTimers.clear();
  if (stopped > 0) {appLogger.info("BargazBot tracked timers stopped:", stopped);}
  return stopped;
}

export function getActiveTaskCount() {
  return activeTasks.size;
}

export async function drainBotTasks() {
  while (activeTasks.size > 0) {
    await Promise.allSettled([...activeTasks]);
  }
}