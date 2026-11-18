import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const workflow = readFileSync(new URL('../.github/workflows/claude-code-review.yml', import.meta.url), 'utf8')
const events = workflow.match(/^    types: \[(.*)\]/m)?.[1].split(', ') ?? []

describe('Claude review workflow', () => {
  it('skips draft PRs before authentication and runs again when a PR becomes ready', () => {
    const condition = workflow.match(/^    if: (.*)$/m)?.[1]
    expect(condition?.split(' && ')).toContain('!github.event.pull_request.draft')
    expect(events).toContain('ready_for_review')
  })

  it('lets draft conversions cancel reviews while isolating other draft events', () => {
    expect(events).toContain('converted_to_draft')
    expect(workflow).toMatch(/^  cancel-in-progress: true$/m)
    expect(workflow).toMatch(/^  group: .*github\.event\.pull_request\.draft && github\.event\.action != 'converted_to_draft' && '-draft'/m)
  })
})
