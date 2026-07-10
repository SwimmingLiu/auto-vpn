export const MAIN_DATA_PLACEHOLDER = '__MAIN_DATA__';

export interface RenderInput {
  template: string;
  links: string[];
}

export interface RenderOutput {
  rendered_source: string;
}

export interface RenderBackendOptions {}

export function replaceMainData(template: string, links: string[]): string {
  const occurrences = template.split(MAIN_DATA_PLACEHOLDER).length - 1;
  if (occurrences !== 1) {
    throw new Error('Template must contain exactly one MainData placeholder');
  }
  return template.replace(MAIN_DATA_PLACEHOLDER, links.join('\n'));
}

export function runRender(input: RenderInput): RenderOutput {
  return {
    rendered_source: replaceMainData(input.template, input.links ?? [])
  };
}

export async function renderMainDataWithBackend(input: RenderInput, options: RenderBackendOptions = {}): Promise<RenderOutput> {
  void options;
  return runRender(input);
}
