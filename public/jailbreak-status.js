// A root browser needs no credential change; a successful setuid also proves HEN is active.
export function alreadyJailbroken(sc, sys) {
  if (!Number.isInteger(sys.getuid) || !Number.isInteger(sys.setuid)) throw Error('Missing jailbreak detection syscall');
  const uid = sc(sys.getuid).i32;
  if (uid === 0) return true;
  if (uid < 0) throw Error('Could not read browser credentials');
  return sc(sys.setuid, 0).i32 === 0;
}
