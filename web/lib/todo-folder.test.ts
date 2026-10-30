import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { todoFolder } from './todo'

describe('todoFolder', () => {
  it('picks the longest project holding the chat', () => {
    assert.equal(todoFolder(['/u/a', '/u/a/b'], '/u/a/b/c'), '/u/a/b')
    assert.equal(todoFolder(['/u/a', '/u/ab'], '/u/ab/x'), '/u/ab')
    assert.equal(todoFolder(['/u/a'], '/v', '/u/a/x'), '/u/a')
  })
  it('takes Windows paths with backslashes and either drive-letter case', () => {
    assert.equal(todoFolder(['C:\\Users\\k\\GitHub\\app', 'D:\\x'], 'c:\\Users\\k\\GitHub\\app\\web'), 'C:\\Users\\k\\GitHub\\app')
    assert.equal(todoFolder(['D:\\x', 'C:\\Users\\k\\app'], 'C:/Users/k/app'), 'C:\\Users\\k\\app')
    assert.equal(todoFolder(['D:\\x', 'C:\\Users\\k\\app'], 'C:\\Users\\k\\apple'), 'D:\\x')
  })
})
