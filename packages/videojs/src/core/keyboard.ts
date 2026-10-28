/**
 * True for a plain "c" press that cycles captions: no modifiers, repeat, IME composition or text field. On
 * non-Latin layouts the physical C key counts too, unless it types another Latin letter (Dvorak "j").
 */
export function isCaptionsKey(event: KeyboardEvent): boolean {
  if (event.repeat || event.isComposing) return false;
  const typedC = event.key === 'c' || event.key === 'C';
  const physicalC = event.code === 'KeyC' && !/^[a-zA-Z]$/.test(event.key);
  if (!typedC && !physicalC) return false;
  if (event.ctrlKey || event.metaKey || event.altKey) return false;
  const target = event.target as HTMLElement | null;
  if (!target) return true;
  return !target.isContentEditable && !/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName ?? '');
}
