import { createLogger, format, transports } from "winston";

// Reuturn a default console logger
export default createLogger({
  level: "info",
  format: format.combine(
    format(info => {
      info.level = `${info.level.toUpperCase()}`;
      return info;
    })(),
    format.colorize(),
    format.timestamp({
      format: "YYYY-MM-DDTHH:mm:ss"
    }),
    format.printf(info => `${info.timestamp} ${info.level} ${info.message}`)
  ),
  transports: [new transports.Console()]
});
