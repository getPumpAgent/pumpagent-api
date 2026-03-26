import pino from "pino";

const logger = pino({
  transport: {
    target: "pino-pretty",
    options: {
      colorize: true,
      translateTime: "HH:MM:ss",
      ignore: "pid,hostname",
    },
  },
});

export function createLogger(module: string) {
  return logger.child({ module });
}

export default logger;
