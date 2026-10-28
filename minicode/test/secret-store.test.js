import test from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { startSecretStore } from '../server/secret-store.js'

function request(env, message) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port: Number(env.MINICODE_SECRET_STORE_PORT) })
    let text = ''
    socket.setEncoding('utf8')
    socket.on('error', reject)
    socket.on('connect', () => socket.write(JSON.stringify({ capability: env.MINICODE_SECRET_STORE_CAPABILITY, ...message }) + '\n'))
    socket.on('data', chunk => { text += chunk })
    socket.on('end', () => { try { resolve(JSON.parse(text)) } catch (error) { reject(error) } })
  })
}

test('process store shares values with child processes and rejects invalid capabilities', async () => {
  const store = await startSecretStore()
  try {
    assert.deepEqual(await request(store.env, { op: 'set', key: 'test/key', value: 'dummy-value' }), { ok: true })
    assert.deepEqual(await request(store.env, { op: 'get', key: 'test/key', capability: 'wrong' }), { ok: false })
    const child = spawn(process.execPath, ['--input-type=module', '-e', `
      import net from 'node:net';
      const s = net.createConnection({host:'127.0.0.1', port:Number(process.env.MINICODE_SECRET_STORE_PORT)});
      let data=''; s.setEncoding('utf8');
      s.on('connect',()=>s.write(JSON.stringify({op:'get',key:'test/key',capability:process.env.MINICODE_SECRET_STORE_CAPABILITY})+'\\n'));
      s.on('data',x=>data+=x); s.on('end',()=>{if(JSON.parse(data).value!=='dummy-value') process.exitCode=1});
      s.on('error',()=>{process.exitCode=1});
    `], { env: { ...process.env, ...store.env }, stdio: 'ignore' })
    const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve) })
    assert.equal(code, 0)
    assert.deepEqual(await request(store.env, { op: 'delete', key: 'test/key' }), { ok: true })
    assert.deepEqual(await request(store.env, { op: 'get', key: 'test/key' }), { ok: true, value: null })
  } finally { store.close() }
})
