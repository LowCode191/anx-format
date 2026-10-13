import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const workspace = path.resolve(import.meta.dirname, '..')
const sample = path.join(workspace, 'examples/sample.anx')
const digest = async () => createHash('sha256').update(await readFile(sample)).digest('hex')
for (const server of ['mcp-server', 'evidence-mcp-server']) {
  test(`stdio smoke: ${server} initializes, lists and reads over real stdio`, { timeout: 60000 }, async () => {
    const before = await digest()
    const transport = new StdioClientTransport({
      command: process.execPath, args: ['--import', 'tsx', path.join(workspace, 'src', server + '.ts')],
      cwd: workspace, env: { PATH: process.env.PATH || '', ANX_ALLOWED_ROOT: workspace },
      stderr: 'pipe',
    })
    const client = new Client({ name: 'anx-readonly-smoke', version: '1.0.0' })
    try {
      await client.connect(transport)
      const tools = await client.listTools()
      const name = server === 'mcp-server' ? 'andoc_open' : 'anx_search'
      assert(tools.tools.some(tool => tool.name === name))
      const result = await client.callTool({ name, arguments: { documentPath: 'examples/sample.anx', ...(name === 'anx_search' ? { query: 'ANX' } : {}) } })
      assert.notEqual(result.isError, true)
      assert(Array.isArray(result.content) && result.content.length > 0)
      const denied = await client.callTool({ name, arguments: { documentPath: '../outside.anx', ...(name === 'anx_search' ? { query: 'ANX' } : {}) } })
      assert.equal(denied.isError, true)
    } finally {
      await client.close()
      await transport.close()
    }
    assert.equal(await digest(), before)
  })
}
