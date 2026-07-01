import { CliUsageError } from '../errors.js';
import { readOptionValue } from '../global-options.js';

const TOP_LEVEL_COMMANDS = new Set([
  'profile',
  'doctor',
  'artifacts',
  'run',
  'retry-stage',
  'resume',
  'jobs',
  'status',
  'logs',
  'stop'
]);

const JOBS_SUBCOMMANDS = new Set(['list', 'status', 'logs', 'stop', 'resume', 'retry']);
const RESUME_SUBCOMMANDS = new Set(['pipeline', 'speedtest']);
const PROFILE_SUBCOMMANDS = new Set(['show', 'save', 'summary']);
const ARTIFACT_SUBCOMMANDS = new Set(['latest', 'list', 'preview']);

function validateChoice(commandLabel: string, optionName: string, value: string | undefined, choices: string[]): void {
  if (value === undefined || choices.includes(value)) {
    return;
  }
  throw new CliUsageError(`${commandLabel} ${optionName} must be one of: ${choices.join(', ')}`);
}

function requireOption(commandLabel: string, argv: string[], optionName: string): string {
  const value = readOptionValue(argv, optionName);
  if (value === undefined || value === '') {
    throw new CliUsageError(`${commandLabel} requires ${optionName}`);
  }
  return value;
}

function findJobsSubcommand(argv: string[]): string {
  for (let index = 1; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--project-root') {
      index += 1;
      continue;
    }
    if (value.startsWith('--project-root=')) {
      continue;
    }
    if (JOBS_SUBCOMMANDS.has(value)) {
      return value;
    }
    if (!value.startsWith('-')) {
      return value;
    }
  }
  return '';
}

function findSubcommand(argv: string[], choices: Set<string>): string {
  for (let index = 1; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--project-root' || value === '--format' || value === '--tail' || value === '--output' || value === '--artifact-dir' || value === '--stage') {
      index += 1;
      continue;
    }
    if (value.startsWith('--project-root=')) {
      continue;
    }
    if (choices.has(value)) {
      return value;
    }
    if (!value.startsWith('-')) {
      return value;
    }
  }
  return '';
}

export function validateCommand(argv: string[]): void {
  const command = argv[0];
  if (!command) {
    throw new CliUsageError('missing command');
  }
  if (command.startsWith('-')) {
    throw new CliUsageError(`unknown option: ${command}`);
  }
  if (!TOP_LEVEL_COMMANDS.has(command)) {
    throw new CliUsageError(`unknown command: ${command}`);
  }

  if (command === 'doctor') {
    validateChoice('doctor', '--output', readOptionValue(argv, '--output'), ['human', 'json']);
    return;
  }

  if (command === 'profile') {
    const subcommand = argv[1] ?? '';
    if (!PROFILE_SUBCOMMANDS.has(subcommand)) {
      throw new CliUsageError('profile subcommand must be one of: show, save, summary');
    }
    return;
  }

  if (command === 'artifacts') {
    const subcommand = argv[1] ?? '';
    if (!ARTIFACT_SUBCOMMANDS.has(subcommand)) {
      throw new CliUsageError('artifacts subcommand must be one of: latest, list, preview');
    }
    if (subcommand === 'preview' && !findSubcommand(argv.slice(argv.indexOf(subcommand)), new Set())) {
      throw new CliUsageError('artifacts preview requires artifact_dir');
    }
    return;
  }

  if (command === 'run' || command === 'retry-stage' || command === 'resume') {
    validateChoice(command, '--output', readOptionValue(argv, '--output'), ['jsonl', 'human']);
    if (command === 'retry-stage') {
      requireOption('retry-stage', argv, '--artifact-dir');
      requireOption('retry-stage', argv, '--stage');
    }
    if (command === 'resume') {
      const subcommand = argv[1] ?? '';
      if (!RESUME_SUBCOMMANDS.has(subcommand)) {
        throw new CliUsageError('resume subcommand must be one of: pipeline, speedtest');
      }
      requireOption('resume', argv, '--session');
    }
    return;
  }

  if (command === 'logs') {
    validateChoice('logs', '--format', readOptionValue(argv, '--format'), ['human', 'jsonl']);
    return;
  }

  if (command === 'jobs') {
    const subcommand = findJobsSubcommand(argv);
    if (!JOBS_SUBCOMMANDS.has(subcommand)) {
      throw new CliUsageError('jobs subcommand must be one of: list, status, logs, stop, resume, retry');
    }
    if (['status', 'logs', 'stop', 'resume'].includes(subcommand)) {
      const value = findSubcommand(argv.slice(argv.indexOf(subcommand)), new Set());
      if (!value) {
        throw new CliUsageError(`jobs ${subcommand} requires job_id`);
      }
    }
    if (subcommand === 'logs') {
      validateChoice('jobs logs', '--format', readOptionValue(argv, '--format'), ['human', 'jsonl']);
    }
    if (subcommand === 'resume' || subcommand === 'retry') {
      validateChoice(`jobs ${subcommand}`, '--output', readOptionValue(argv, '--output'), ['jsonl', 'human']);
    }
    if (subcommand === 'retry') {
      requireOption('jobs retry', argv, '--artifact-dir');
      requireOption('jobs retry', argv, '--stage');
    }
  }
}
