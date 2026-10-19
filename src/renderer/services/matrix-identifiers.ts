/** Matrix identifier display helpers. */
export function mxidLocalpart(mxid: string): string {
  if (mxid.charAt(0) !== "@") return mxid;
  return mxid.slice(1).split(":")[0] ?? mxid;
}

