export const ExitCode = {
  SUCCESS: 0,
  FAILURE: 1,
  PARTIAL: 2,
  TIMEOUT: 3,
} as const;

export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode];
