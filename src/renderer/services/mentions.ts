/** Explicit Matrix IDs in message text become interoperable mention metadata. */
export function mentionedUsers(body: string, members: Iterable<string>): string[] {
  return [...new Set(members)].filter(id => {
    let start = body.indexOf(id);
    while (start >= 0) {
      const before = body[start - 1], after = body[start + id.length];
      if ((!before || /[\s([{]/.test(before)) && (!after || /[\s)\]},!?;。]/.test(after) || after === "." && !/[a-z0-9]/i.test(body[start + id.length + 1] ?? ""))) return true;
      start = body.indexOf(id, start + id.length);
    }
    return false;
  });
}
