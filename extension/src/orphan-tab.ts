/**
 * After an extension host restart (Restart Extension Host, or VS Code updating any extension) the editor tab stays
 * wired to the dead host and VS Code never revives it. Such a tab is on screen in a group where no panel of this
 * host shows (owned: the columns of this host's visible panels). A background tab is skipped: after a reload VS Code
 * revives it only once it is shown.
 */
export function orphanTab<T extends { isActive: boolean; group: { viewColumn: number }; input: unknown }>(tabs: readonly T[], owned: readonly number[]): T | undefined {
  return tabs.find(t => {
    const viewType = (t.input as { viewType?: unknown } | undefined)?.viewType
    return t.isActive && typeof viewType === 'string' && viewType.endsWith('agentVisualizer') && !owned.includes(t.group.viewColumn)
  })
}
