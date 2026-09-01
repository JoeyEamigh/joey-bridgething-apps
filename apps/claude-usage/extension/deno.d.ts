declare namespace Deno {
  interface DirEntry {
    name: string;
    isFile: boolean;
    isDirectory: boolean;
    isSymlink: boolean;
  }

  interface FileInfo {
    size: number;
    mtime: Date | null;
    isFile: boolean;
    isDirectory: boolean;
  }

  enum SeekMode {
    Start = 0,
    Current = 1,
    End = 2,
  }

  interface FsFile {
    read(buffer: Uint8Array): Promise<number | null>;
    seek(offset: number, whence: SeekMode): Promise<number>;
    close(): void;
  }

  interface CommandOutput {
    success: boolean;
    code: number;
    stdout: Uint8Array;
    stderr: Uint8Array;
  }

  interface CommandOptions {
    args?: string[];
    env?: Record<string, string>;
    cwd?: string;
    stdout?: 'piped' | 'inherit' | 'null';
    stderr?: 'piped' | 'inherit' | 'null';
    stdin?: 'piped' | 'inherit' | 'null';
  }

  class Command {
    constructor(command: string, options?: CommandOptions);
    output(): Promise<CommandOutput>;
  }

  const build: { os: 'darwin' | 'linux' | 'windows' | string };
  const env: { get(key: string): string | undefined };

  interface HttpServer {
    shutdown(): Promise<void>;
    finished: Promise<void>;
  }

  function serve(
    options: { port: number; hostname: string; onListen?: () => void; onError?: (err: unknown) => Response },
    handler: (request: Request) => Response | Promise<Response>,
  ): HttpServer;

  function open(path: string, options?: { read?: boolean; write?: boolean; createNew?: boolean }): Promise<FsFile>;
  function readDirSync(path: string): Iterable<DirEntry>;
  function readTextFile(path: string): Promise<string>;
  function writeTextFile(path: string, data: string, options?: { mode?: number }): Promise<void>;
  function realPathSync(path: string): string;
  function rename(from: string, to: string): Promise<void>;
  function remove(path: string): Promise<void>;
  function stat(path: string): Promise<FileInfo>;
  function statSync(path: string): FileInfo;
}
