/** Private tasks suspend background capture as well as their own training. */
const privateTasks = new Set<string>();
let epoch = 0;
export function setPrivateTask(taskId: string, on: boolean): void {
  if (on) privateTasks.add(taskId); else privateTasks.delete(taskId);
  epoch++;
}
export const captureAllowed = (): boolean => privateTasks.size === 0;
export const deletionEpoch = (): number => epoch;
export function invalidateCaptures(): number { return ++epoch; }
