/** Spread independent session roots before applying forces. Coincident roots
 * cause a large initial repulsion and make the auto-fit camera zoom too far out. */
export function initialRootPosition(index: number): { x: number; y: number } {
  const angle = index * 2.399963229728653
  const radius = 550 * Math.sqrt(index)
  return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius }
}
