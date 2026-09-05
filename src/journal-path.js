import { constants as C, openSync, closeSync, fstatSync, lstatSync, fsyncSync } from "node:fs";
import { isAbsolute, normalize, dirname, basename } from "node:path";

// Linux service topology. Node/SQLite cannot accept an open database descriptor.
// Pin each directory with O_NOFOLLOW and use the pinned parent for SQLite's path.
// SQLite may canonicalize it: trusted ancestors and inode rechecks remain mandatory.
export class PrivateJournalPath {
  #fds = [];
  #checks = [];
  #uid;
  #stat;
  #file;

  constructor(path, uid, stat = lstatSync) {
    this.#uid = uid;
    this.#stat = stat;
    try {
      if (process.platform !== "linux" || typeof path !== "string" || !isAbsolute(path)
          || normalize(path) !== path || path.includes("\0") || path === "/") throw new Error();
      let current = "/";
      let fd;
      for (const part of ["", ...dirname(path).split("/").filter(Boolean)]) {
        const anchored = fd === undefined ? "/" : `/proc/self/fd/${fd}/${part}`;
        current = part ? (current === "/" ? `/${part}` : `${current}/${part}`) : "/";
        const before = stat(current);
        this.#directory(before, current === dirname(path));
        fd = openSync(anchored, C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW);
        this.#fds.push(fd);
        const actual = fstatSync(fd);
        if (actual.dev !== before.dev || actual.ino !== before.ino) throw new Error();
        this.#checks.push({ path: current, dev: actual.dev, ino: actual.ino, parent: current === dirname(path) });
      }
      this.path = `/proc/self/fd/${fd}/${basename(path)}`;
      this.fresh = false;
      let file;
      try {
        file = openSync(this.path, C.O_RDWR | C.O_CREAT | C.O_EXCL | C.O_NOFOLLOW, 0o600);
        this.fresh = true;
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        this.#privateFile(lstatSync(this.path));
        file = openSync(this.path, C.O_RDWR | C.O_NOFOLLOW | C.O_NONBLOCK);
      }
      this.#fds.push(file);
      this.#file = fstatSync(file);
      this.#privateFile(this.#file);
      this.verify();
    } catch {
      this.close();
      throw new Error("unsafe journal filesystem");
    }
  }

  #directory(info, parent) {
    if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o022)
        || (parent ? info.uid !== this.#uid || (info.mode & 0o077) : ![0, this.#uid].includes(info.uid))) throw new Error();
  }

  #privateFile(info) {
    if (!info.isFile() || info.isSymbolicLink() || info.uid !== this.#uid
        || (info.mode & 0o077) || info.nlink !== 1) throw new Error();
  }

  verify() {
    for (const check of this.#checks) {
      const info = this.#stat(check.path);
      this.#directory(info, check.parent);
      if (info.dev !== check.dev || info.ino !== check.ino) throw new Error();
    }
    const file = lstatSync(this.path);
    this.#privateFile(file);
    if (file.dev !== this.#file.dev || file.ino !== this.#file.ino) throw new Error();
    for (const suffix of ["-wal", "-shm", "-journal"]) {
      try { this.#privateFile(lstatSync(this.path + suffix)); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
    }
  }

  syncCreation() {
    // Persist the new database's directory entry before reporting initialization.
    fsyncSync(this.#fds.at(-1));
    fsyncSync(this.#fds.at(-2));
  }

  close() { for (const fd of this.#fds.splice(0).reverse()) closeSync(fd); }
}
