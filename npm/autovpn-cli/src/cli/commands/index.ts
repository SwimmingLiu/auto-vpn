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

function validateChoice(commandLabel: string, optionName: string, value: string | undefined, choices: string[]): void {
  if (value === undefined || choices.includes(value)) {
    return;
  }
  throw new CliUsageError(`${commandLabel} ${optionName} must be one of: ${choices.join(', ')}`);
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

  if (command === 'run' || command === 'retry-stage' || command === 'resume') {
    validateChoice(command, '--output', readOptionValue(argv, '--output'), ['jsonl', 'human']);
    return;
  }

  if (command === 'logs') {
    validateChoice('logs', '--format', readOptionValue(argv, '--format'), ['human', 'jsonl']);
    return;
  }

  if (command === 'jobs') {
    const subcommand = findJobsSubcommand(argv);
    if (subcommand === 'logs') {
      validateChoice('jobs logs', '--format', readOptionValue(argv, '--format'), ['human', 'jsonl']);
    }
    if (subcommand === 'resume' || subcommand === 'retry') {
      validateChoice(`jobs ${subcommand}`, '--output', readOptionValue(argv, '--output'), ['jsonl', 'human']);
    }
  }
}
