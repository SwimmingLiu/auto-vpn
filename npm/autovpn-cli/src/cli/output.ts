export interface CliIo {
  writeStdout(chunk: string): void;
  writeStderr(chunk: string): void;
}

export function defaultIo(): CliIo {
  return {
    writeStdout(chunk: string) {
      process.stdout.write(chunk);
    },
    writeStderr(chunk: string) {
      process.stderr.write(chunk);
    }
  };
}

export function renderHelp(): string {
  return `AutoVPN headless command line interface

Usage:
  autovpn --help
  autovpn --version
  autovpn <command> [options]

Commands:
  profile show|save|summary
  accounts import|list|stats|snapshot|disable|enable|expire|refresh-expiry|export|template
  doctor
  artifacts latest|list|preview
  run
  retry-stage
  resume pipeline|speedtest
  jobs list|status|logs|stop|resume|retry
  status
  logs
  stop
  serve
`;
}
