// Protocol fixture worker for the engine-glue tests: implements the same
// message protocol as electron/store/localModelWorker.ts with artificial
// latency and a crash trigger — no llama runtime involved.
import { parentPort } from 'node:worker_threads'

if (parentPort) {
  parentPort.on('message', (msg) => {
    if (msg.type === 'load') {
      setTimeout(() => parentPort.postMessage({ type: 'load-result', ok: true }), 5)
    } else if (msg.type === 'infer') {
      if (msg.history && msg.history[0] && msg.history[0].content === 'boom') {
        throw new Error('fixture crash')
      }
      if (msg.history && msg.history[0] && msg.history[0].content === 'hang') {
        return // never reply: simulates a wedged native inference
      }
      setTimeout(() => parentPort.postMessage({ type: 'infer-result', id: msg.id, ok: true, text: 'reply-' + msg.id }), 5)
    } else if (msg.type === 'dispose') {
      process.exit(0)
    }
  })
}
