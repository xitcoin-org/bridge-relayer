import { lstatSync } from "node:fs";
// /tmp is deliberately not a production trust root. Inject only its metadata in
// offline tests; all fixture directories/files retain real ownership and modes.
export function journalOptions(destination = "xitcoin") {
  return {
    identity: () => ({ username: `xitcoin-bridge-submitter-${destination}`, uid: process.geteuid() }),
    stat(path) {
      const info = lstatSync(path);
      if (path === "/tmp") return Object.assign(info, { mode: (info.mode & ~0o777) | 0o755 });
      return info;
    },
  };
}
