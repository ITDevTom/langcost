import type { CliIo } from "../types";

function wrap(code: string, value: string, useColor: boolean): string {
  return useColor ? `\u001B[${code}m${value}\u001B[0m` : value;
}

export function createPalette(io: CliIo) {
  return {
    bold(value: string) {
      return wrap("1", value, io.useColor);
    },
    dim(value: string) {
      return wrap("2", value, io.useColor);
    },
    red(value: string) {
      return wrap("31", value, io.useColor);
    },
    green(value: string) {
      return wrap("32", value, io.useColor);
    },
    yellow(value: string) {
      return wrap("33", value, io.useColor);
    },
    blue(value: string) {
      return wrap("34", value, io.useColor);
    },
    cyan(value: string) {
      return wrap("36", value, io.useColor);
    },
  };
}
