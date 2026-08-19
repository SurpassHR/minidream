import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';

export interface ProjectDirectoryPickerResult {
  path: string | null;
  available: boolean;
}

type PickerRunResult = {
  status: number | null;
  stdout?: string | Buffer;
  error?: Error;
};

type PickerRunner = (
  command: string,
  args: string[],
  options: { encoding: 'utf8'; stdio: ['ignore', 'pipe', 'ignore'] },
) => PickerRunResult;

interface PickerCommand {
  command: string;
  args: string[];
}

function commandsFor(platform: string, home: string): PickerCommand[] {
  if (platform === 'darwin') {
    return [{
      command: 'osascript',
      args: ['-e', 'POSIX path of (choose folder with prompt "选择项目目录")'],
    }];
  }
  if (platform === 'win32') {
    const script = [
      'Add-Type -AssemblyName System.Windows.Forms;',
      '$d=New-Object System.Windows.Forms.FolderBrowserDialog;',
      '$d.Description="选择项目目录";',
      'if($d.ShowDialog() -eq "OK"){[Console]::Write($d.SelectedPath)}',
    ].join('');
    return [{ command: 'powershell.exe', args: ['-NoProfile', '-Command', script] }];
  }
  return [
    { command: 'zenity', args: ['--file-selection', '--directory', '--title=选择项目目录'] },
    { command: 'kdialog', args: ['--getexistingdirectory', home, '--title', '选择项目目录'] },
  ];
}

// 使用系统原生文件浏览器选择真实目录；取消选择不是错误。
// run 参数仅供测试注入，生产环境使用 node:child_process.spawnSync。
export function pickProjectDirectory(options: {
  platform?: string;
  home?: string;
  run?: PickerRunner;
} = {}): ProjectDirectoryPickerResult {
  const run = options.run ?? ((command, args, runOptions) => spawnSync(command, args, runOptions));
  let pickerAvailable = false;

  for (const picker of commandsFor(options.platform ?? process.platform, options.home ?? homedir())) {
    let result: PickerRunResult;
    try {
      result = run(picker.command, picker.args, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      continue;
    }
    // ENOENT 表示当前系统没有该选择器，继续尝试下一个实现。
    if (result.error) continue;
    pickerAvailable = true;
    const selected = typeof result.stdout === 'string' ? result.stdout.trim() : '';
    return { path: selected || null, available: true };
  }

  return { path: null, available: pickerAvailable };
}
