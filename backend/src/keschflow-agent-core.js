/**
 * KeschFlow Agent Core v0.1
 * Safe, platform-independent orchestration kernel.
 * No network calls, deployments, payments, or autonomous posting.
 * Persistent storage and approved tool adapters must be injected.
 */
export const STATES = Object.freeze({
  QUEUED: 'queued', RUNNING: 'running', WAITING: 'waiting_for_approval',
  COMPLETED: 'completed', FAILED: 'failed', STOPPED: 'stopped'
});

const RISKY = new Set([
  'deploy', 'publish', 'post', 'send_message', 'send_email', 'charge',
  'purchase', 'subscribe', 'delete', 'grant_access', 'modify_secrets',
  'change_dns', 'transfer_funds'
]);

export function createKeschFlowAgent({store, tools = {}, clock = () => new Date().toISOString()} = {}) {
  if (!store || typeof store.get !== 'function' || typeof store.put !== 'function')
    throw new TypeError('Persistent store with get/put is required');

  function validateTask(task) {
    if (!task || typeof task.id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(task.id))
      throw new TypeError('Invalid task id');
    if (!Array.isArray(task.steps) || task.steps.length === 0 || task.steps.length > 50)
      throw new TypeError('Task needs 1–50 steps');
    for (const step of task.steps) {
      if (!step || typeof step.action !== 'string' || !/^[a-z_]{1,60}$/.test(step.action))
        throw new TypeError('Invalid action');
      if (step.args !== undefined && (step.args === null || typeof step.args !== 'object' || Array.isArray(step.args)))
        throw new TypeError('Step args must be an object');
    }
  }

  async function submit(task) {
    validateTask(task);
    if (await store.get(task.id)) throw new Error('Task id already exists');
    const saved = {id: task.id, objective: String(task.objective || '').slice(0, 1000),
      steps: task.steps.map(s => ({action:s.action,args:s.args || {}})),
      index:0, status:STATES.QUEUED, approvals:{}, results:[], createdAt:clock(), updatedAt:clock()};
    await store.put(task.id, saved);
    return saved;
  }

  async function get(id) { return await store.get(id); }

  async function run(id) {
    const task = await store.get(id);
    if (!task) throw new Error('Unknown task');
    if ([STATES.COMPLETED, STATES.STOPPED, STATES.FAILED].includes(task.status)) return task;
    if (task.status === STATES.RUNNING) throw new Error('Concurrent execution denied');
    task.status = STATES.RUNNING;
    await store.put(id, task);
    try {
      while (task.index < task.steps.length) {
        const step = task.steps[task.index];
        const approvalKey = String(task.index);
        if (RISKY.has(step.action) && task.approvals[approvalKey] !== true) {
          task.status = STATES.WAITING;
          break;
        }
        const tool = tools[step.action];
        if (typeof tool !== 'function') throw new Error('Unregistered action: ' + step.action);
        const result = await tool(structuredClone(step.args), {taskId:id,stepIndex:task.index});
        // Store only a small, sanitized summary; never persist raw secrets or credentials.
        task.results.push({step:task.index,action:step.action,
          summary:typeof result === 'string' ? result.slice(0, 500) : 'executed',at:clock()});
        task.index += 1;
        task.updatedAt = clock();
        await store.put(id, task);
      }
      if (task.index === task.steps.length) task.status = STATES.COMPLETED;
    } catch (error) {
      task.status = STATES.FAILED;
      task.error = String(error?.message || 'Execution failed').slice(0, 300);
    }
    task.updatedAt = clock();
    await store.put(id, task);
    return task;
  }

  async function approve(id, stepIndex, {approvedBy} = {}) {
    const task = await store.get(id);
    if (!task || task.status !== STATES.WAITING || task.index !== stepIndex ||
        !RISKY.has(task.steps[stepIndex]?.action)) throw new Error('No pending approval');
    if (!approvedBy || typeof approvedBy !== 'string') throw new Error('Authenticated approver required');
    task.approvals[String(stepIndex)] = true;
    task.updatedAt = clock();
    await store.put(id, task);
    return task;
  }

  async function stop(id) {
    const task = await store.get(id);
    if (!task) throw new Error('Unknown task');
    if (task.status === STATES.RUNNING) throw new Error('Cannot interrupt active step safely');
    task.status = STATES.STOPPED;
    task.updatedAt = clock();
    await store.put(id, task);
    return task;
  }

  return Object.freeze({submit,get,run,approve,stop});
}
