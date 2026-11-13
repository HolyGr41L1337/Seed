// Shell commands for tests, written for the shell the shell tool uses on this
// platform: bash elsewhere, PowerShell on Windows.
export const IS_WINDOWS = process.platform === 'win32';

const psQuote = (s) => `'${String(s).replace(/'/g, "''")}'`;
const shQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

export const cmd = {
  touch: (file) => (IS_WINDOWS ? `New-Item -ItemType File -Force -Path ${psQuote(file)} | Out-Null` : `touch ${shQuote(file)}`),
  sleep: (seconds) => (IS_WINDOWS ? `Start-Sleep -Seconds ${seconds}` : `sleep ${seconds}`),
  cat: (file) => (IS_WINDOWS ? `Get-Content ${psQuote(file)}` : `cat ${shQuote(file)}`),
  pwd: IS_WINDOWS ? '(Get-Location).Path' : 'pwd',
  /** Prints "hi" on stdout, then "err" on stderr. */
  stdoutThenStderr: IS_WINDOWS ? `Write-Output hi; [Console]::Error.WriteLine('err')` : 'echo hi && echo err >&2',
};
