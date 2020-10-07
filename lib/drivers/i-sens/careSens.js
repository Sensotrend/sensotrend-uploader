/*
 * == BSD2 LICENSE ==
 * Copyright (c) 2020, Tidepool Project
 *
 * This program is free software; you can redistribute it and/or modify it under
 * the terms of the associated License, which is identical to the BSD 2-Clause
 * License as published by the Open Source Initiative at opensource.org.
 *
 * This program is distributed in the hope that it will be useful, but WITHOUT
 * ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS
 * FOR A PARTICULAR PURPOSE. See the License for more details.
 *
 * You should have received a copy of the License along with this program; if
 * not, you can obtain one from Tidepool Project at tidepool.org.
 * == BSD2 LICENSE ==
 */

import _ from 'lodash';
import sundial from 'sundial';

import annotate from '../../eventAnnotations';
import common from '../../commonFunctions';
import TZOUtil from '../../TimezoneOffsetUtil';
import structJs from '../../struct';
import crcCalculator from '../../crc';

const struct = structJs();
const isBrowser = typeof window !== 'undefined';
// eslint-disable-next-line no-console
const debug = isBrowser ? require('bows')('CareSensDriver') : console.log;

const COMMAND = {
  HEADER: 'iSPc',
  GLUCOSE_RESULT: 'GLUE',
  CURRENT_INDEX: 'NCOT',
  READ_SERIAL: 'RSNB',
  READ_TIME: 'RTIM',
  WRITE_TIME: 'WTIM',
};

const ASCII_CONTROL = {
  STX: 0x02,
  ETX: 0x03,
};

const REPORT_ID = {
  GET_SET_UART_ENABLE: 0x41,
  GET_VERSION_INFO: 0x46,
  GET_SET_UART_CONFIG: 0x50,
};

const PARITY = {
  NONE: 0,
  ODD: 1,
  EVEN: 2,
  MARK: 3,
  SPACE: 4,
};

const FLOW_CONTROL = {
  NONE: 0,
  HARDWARE: 1,
};

const DATA_BITS = {
  FIVE: 0x00,
  SIX: 0x01,
  SEVEN: 0x02,
  EIGHT: 0x03,
};

const STOP_BITS = {
  SHORT: 0x00,
  LONG: 0x01,
};

const UART_CONFIG = {
  baud: 9600,
  parity: PARITY.NONE,
  flowControl: FLOW_CONTROL.NONE,
  dataBits: DATA_BITS.EIGHT,
  stopBits: STOP_BITS.SHORT,
};

const ERROR = {
  TIMEOUT: { value: 'TOUT', name: 'Communication timeout' },
  HEADER_VERIFY: { value: 'HEAD', name: 'Could not verify header packet' },
  SIZE_VERIFY: { value: 'SIZE', name: 'Could not verify size of packet' },
  CRC_VERIFY: { value: 'ECRC', name: 'Could not verify CRC of packet' },
  COMMAND_VERIFY: { value: 'CMND', name: 'Could not verify packet command' },
};

const FLAGS = {
  CONTROL_SOLUTION: { value: 0x01, name: 'Control Solution Test' },
  POST_MEAL: { value: 0x02, name: 'Post-meal' },
  LO: { value: 0x04, name: 'Low measurement result' },
  HI: { value: 0x08, name: 'High measurement result' },
  FASTING: { value: 0x10, name: 'Fasting measurement result' },
  NORMAL: { value: 0x20, name: 'Normal measurement result with no flag' },
  KETONE: { value: 0x40, name: 'Ketone measurement result' },
  LOW_HIGH: { value: 0x80, name: 'Low High flags are available' },
};

const READ_TIMEOUT = 2000; // in milliseconds
const HEADER_SIZE = 6;
const KETONE_VALUE_FACTOR = 10;
const KETONE_HI = 8.0;

class CareSens {
  constructor(cfg) {
    this.cfg = cfg;
    this.hidDevice = this.cfg.deviceComms;
    this.retries = 0;
  }

  static buildPacket(command, payload = []) {
    const datalen = 7 + payload.length; // includes length of command, payload, CRC and ETX
    const packetlen = datalen + 7; // adds header, size and STX
    const buf = new ArrayBuffer(packetlen);
    const bytes = new Uint8Array(buf);

    let ctr = struct.pack(bytes, 0, 'bb4zb4z', packetlen, ASCII_CONTROL.STX, COMMAND.HEADER, datalen, command);
    ctr += struct.copyBytes(bytes, ctr, payload, payload.length);
    struct.storeByte(ASCII_CONTROL.ETX, bytes, ctr); // to calculate CRC, overwritten below
    const crc = crcCalculator.calcCRC_A(bytes.slice(1), packetlen - 3);
    ctr += struct.pack(bytes, ctr, 'Sb', crc, ASCII_CONTROL.ETX);

    debug('Sending:', common.bytes2hex(bytes));

    return buf;
  }

  static enableUART(hidDevice) {
    const buf = new ArrayBuffer(9);
    const bytes = new Uint8Array(buf);

    struct.pack(bytes, 0, 'bIbbbb', REPORT_ID.GET_SET_UART_CONFIG, UART_CONFIG.baud, UART_CONFIG.parity, UART_CONFIG.flowControl, UART_CONFIG.dataBits, UART_CONFIG.stopBits);

    debug('UART config:', common.bytes2hex(bytes));

    debug('Configuring and enabling UART..');
    hidDevice.sendFeatureReport(buf);
    hidDevice.sendFeatureReport([REPORT_ID.GET_SET_UART_ENABLE, 1]);
  }

  static verifyChecksum(bytes, expected) {
    bytes.splice(bytes.length - 3, 2); // remove two existing crc bytes
    const calculated = crcCalculator.calcCRC_A(bytes, bytes.length);
    if (calculated !== expected) {
      debug('Checksum is', calculated.toString(16), ', expected', expected.toString(16));
      throw new Error('Checksum mismatch');
    }
  }

  static extractHeader(bytes) {
    const fields = struct.unpack(bytes, 0, '.4zb', ['header', 'size']);
    debug('Header:', fields);
    if (fields.header !== COMMAND.HEADER) {
      throw new Error('Header not found');
    } else {
      return fields;
    }
  }

  static extractPacketIntoMessages(bytes) {
    const fields = CareSens.extractHeader(bytes);

    const response = struct.unpack(bytes, 6, `4z${fields.size - 7}BS`, ['command', 'data', 'crc']);
    debug('Decoded:', response);

    if (response.command !== COMMAND.GLUCOSE_RESULT) { // glucose result does not use CRC :-O
      CareSens.verifyChecksum(bytes, response.crc);
    }

    return response;
  }

  async commandResponse(cmd, payload) {
    let message = '';

    const bytesWritten = await this.hidDevice.sendPromisified(CareSens.buildPacket(cmd, payload));
    debug('Sent', bytesWritten, 'bytes.');

    let raw = [];
    let result;
    let foundSTX = false;
    let foundETX = false;
    let packetSize = 64;
    do {
      result = [];
      // requests to devices are sequential
      // eslint-disable-next-line no-await-in-loop
      result = await this.hidDevice.receiveTimeout(READ_TIMEOUT);
      debug('Incoming bytes:', common.bytes2hex(result));

      if (result.length > 0) {
        const length = result[0];
        const bytes = result.slice(1, length + 1);

        if (!foundSTX) {
          if (bytes.includes(ASCII_CONTROL.STX)) {
            foundSTX = true;
          }
        }

        if (foundSTX) {
          raw = raw.concat(bytes);

          if (raw.length === HEADER_SIZE) {
            const fields = CareSens.extractHeader(raw);
            packetSize = fields.size;
          }

          if (bytes.includes(ASCII_CONTROL.ETX) && raw.length >= (packetSize + HEADER_SIZE)) {
            foundETX = true;
          }
        }
      }
    } while (!foundETX);

    // Only process if we get data
    if (raw.length > 0) {
      debug('Packet:', String.fromCharCode.apply(null, raw));
      message = CareSens.extractPacketIntoMessages(raw);
    }

    // check for errors
    const err = common.getName(ERROR, message.command);
    if (err !== 'unknown') {
      throw new Error(err);
    } else {
      return message;
    }
  }

  async getSerialNumber() {
    const result = await this.commandResponse(COMMAND.READ_SERIAL);
    return String.fromCharCode.apply(null, _.dropRight(result.data)).trim();
  }

  async getDateTime() {
    const result = await this.commandResponse(COMMAND.READ_TIME);
    const fields = struct.unpack(result.data, 0, 'bbbbbb', ['year', 'month', 'day', 'hours', 'minutes', 'seconds']);
    fields.year += 2000;
    return sundial.buildTimestamp(fields);
  }

  async getNumberOfRecords() {
    const result = await this.commandResponse(COMMAND.CURRENT_INDEX);
    return struct.extractBEShort(result.data, 0);
  }

  async getRecords(nrOfRecords) {
    const records = [];

    for (let startIndex = 1; startIndex <= nrOfRecords; startIndex += 27) {
      // eslint-disable-next-line no-bitwise
      const count = ((nrOfRecords - startIndex) >= 27) ? 27 : nrOfRecords - startIndex + 1;
      const buf = new ArrayBuffer(3);
      const bytes = new Uint8Array(buf);

      debug(`Requesting from ${startIndex} to ${startIndex + count - 1} of ${nrOfRecords}`);
      struct.pack(bytes, 0, 'Sb', startIndex, count);

      // requests to devices are sequential
      // eslint-disable-next-line no-await-in-loop
      const result = await this.commandResponse(COMMAND.GLUCOSE_RESULT, bytes);
      let ctr = 0;

      for (let i = 0; i < count; i++) {
        const record = struct.unpack(result.data, ctr, 'bbbbbbbS', ['year', 'month', 'day', 'hours', 'minutes', 'seconds', 'flags', 'value']);
        record.year += 2000;
        record.jsDate = sundial.buildTimestamp(record);
        records.push(record);
        ctr += 9;
      }
    }

    return records;
  }

  async setDateTime(dateTime) {
    const buf = new ArrayBuffer(6);
    const bytes = new Uint8Array(buf);
    struct.pack(bytes, 0, 'bbbbbb', ...dateTime);
    const result = await this.commandResponse(COMMAND.WRITE_TIME, bytes);
    const newDateTime = Array.from(result.data);

    if (!_.isEqual(dateTime, newDateTime)) {
      debug('Set date/time:', dateTime);
      debug('Received date/time:', newDateTime);
      throw new Error('Error setting date/time.');
    }
  }

  static probe(cb) {
    debug('not probing CareSens');
    cb();
  }

  async ping() {
    const bytesWritten = await this.hidDevice.sendPromisified([0x01, 0x80]);
    debug('Sent', bytesWritten, 'bytes.');
    const result = await this.hidDevice.receiveTimeout(READ_TIMEOUT);
    debug('Received:', common.bytes2hex(result));

    if (result.length === 0) {
      if (this.retries <= 3) {
        debug('Retrying..');
        this.retries += 1;
        await this.ping();
      } else {
        throw new Error('Device not responding.');
      }
    } else {
      this.retries = 0;
    }
  }
}

module.exports = (config) => {
  const cfg = _.clone(config);
  _.assign(cfg.deviceInfo, {
    tags: ['bgm'],
    manufacturers: ['i-SENS'],
    model: 'CareSens',
  });

  const hidDevice = config.deviceComms;
  const driver = new CareSens(cfg);

  const hasFlag = (flag, v) => {
    // eslint-disable-next-line no-bitwise
    if (flag.value & v) {
      return true;
    }
    return false;
  };

  const buildBGRecords = (data) => {
    _.forEach(data.records, (record, index) => {
      let { value } = record;

      // According to spec, HI > 500 and LO < 20
      let annotation = null;
      if (hasFlag(FLAGS.HI, record.flags)) {
        value = 601;
        annotation = {
          code: 'bg/out-of-range',
          value: 'high',
          threshold: 600,
        };
      } else if (hasFlag(FLAGS.LO, record.flags)) {
        value = 19;
        annotation = {
          code: 'bg/out-of-range',
          value: 'low',
          threshold: 20,
        };
      } else {
        value = _.toInteger(value);
      }

      if (!hasFlag(FLAGS.CONTROL_SOLUTION, record.flags)
          && !hasFlag(FLAGS.KETONE, record.flags)) {
        const recordBuilder = cfg.builder.makeSMBG()
          .with_value(value)
          .with_units('mg/dL') // values are always in 'mg/dL'
          .with_deviceTime(sundial.formatDeviceTime(record.jsDate))
          .set('index', index);

        cfg.tzoUtil.fillInUTCInfo(recordBuilder, record.jsDate);

        if (annotation) {
          annotate.annotateEvent(recordBuilder, annotation);
        }

        const postRecord = recordBuilder.done();
        delete postRecord.index;
        data.post_records.push(postRecord);
      } else if (hasFlag(FLAGS.CONTROL_SOLUTION, record.flags)) {
        debug('Skipping BG control solution test');
      }
    });
  };

  const buildKetoneRecords = (data) => {
    _.forEach(data.records, (record, index) => {
      if (hasFlag(FLAGS.KETONE, record.flags)) {
        let { value } = record;

        // According to spec, HI > 8 mmol/L
        // there is no LO as values are between 0 and 8 mmol/L
        let annotation = null;
        if (hasFlag(FLAGS.HI, record.flags)) {
          value = KETONE_HI + (1 / KETONE_VALUE_FACTOR);
          annotation = {
            code: 'ketone/out-of-range',
            value: 'high',
            threshold: KETONE_HI,
          };
        } else {
          value = _.toInteger(value) / KETONE_VALUE_FACTOR;
        }

        if (!hasFlag(FLAGS.CONTROL_SOLUTION, record.flags)) {
          const recordBuilder = cfg.builder.makeBloodKetone()
            .with_value(value)
            .with_units('mmol/L') // values are always in 'mmol/L'
            .with_deviceTime(sundial.formatDeviceTime(record.jsDate))
            .set('index', index);

          cfg.tzoUtil.fillInUTCInfo(recordBuilder, record.jsDate);

          if (annotation) {
            annotate.annotateEvent(recordBuilder, annotation);
          }

          const postRecord = recordBuilder.done();
          delete postRecord.index;
          data.post_records.push(postRecord);
        } else {
          debug('Skipping ketone control solution test');
        }
      }
    });
  };

  return {
    /* eslint no-param-reassign:
       [ "error", { "props": true, "ignorePropertyModificationsFor": ["data"] } ] */

    detect(deviceInfo, cb) {
      debug('no detect function needed', deviceInfo);
      cb(null, deviceInfo);
    },

    setup(deviceInfo, progress, cb) {
      debug('in setup!');
      progress(100);
      cb(null, { deviceInfo });
    },

    connect(progress, data, cb) {
      hidDevice.connect(cfg.deviceInfo, CareSens.probe, (err) => {
        if (err) {
          cb(err);
        } else {
          (async () => {
            // The CP2110 chip used implements serial over HID,
            // so we need to enable the UART first.
            // see https://www.silabs.com/documents/public/application-notes/AN434-CP2110-4-Interface-Specification.pdf
            CareSens.enableUART(hidDevice);
            await driver.ping();

            data.disconnect = false;
            progress(100);
            cb(null, data);
          })().catch((error) => cb(error));
        }
      });
    },

    getConfigInfo(progress, data, cb) {
      progress(0);

      (async () => {
        cfg.deviceInfo.serialNumber = await driver.getSerialNumber();
        cfg.deviceInfo.deviceId = `${cfg.deviceInfo.driverId}-${cfg.deviceInfo.serialNumber}`;
        cfg.deviceInfo.deviceTime = sundial.formatDeviceTime(await driver.getDateTime());
        debug('Config:', cfg);

        common.checkDeviceTime(
          cfg,
          (timeErr, serverTime) => {
            progress(100);
            if (timeErr) {
              if (timeErr === 'updateTime') {
                cfg.deviceInfo.annotations = 'wrong-device-time';

                (async () => {
                  const dateTime = [
                    sundial.formatInTimezone(serverTime, cfg.timezone, 'YY'),
                    sundial.formatInTimezone(serverTime, cfg.timezone, 'M'),
                    sundial.formatInTimezone(serverTime, cfg.timezone, 'D'),
                    sundial.formatInTimezone(serverTime, cfg.timezone, 'H'),
                    sundial.formatInTimezone(serverTime, cfg.timezone, 'm'),
                    sundial.formatInTimezone(serverTime, cfg.timezone, 's'),
                  ];
                  await driver.setDateTime(dateTime.map(Number));
                })().then(() => {
                  data.connect = true;
                  return cb(null, data);
                }).catch((error) => {
                  debug('Error in getConfigInfo: ', error);
                  return cb(error, null);
                });
              } else {
                cb(timeErr, null);
              }
            } else {
              data.connect = true;
              cb(null, data);
            }
          },
        );
      })().catch((error) => {
        debug('Error in getConfigInfo: ', error);
        return cb(error, null);
      });
    },

    fetchData(progress, data, cb) {
      (async () => {
        try {
          debug('in fetchData', data);
          data.nrOfRecords = await driver.getNumberOfRecords();
          debug(`Found ${data.nrOfRecords} records..`);

          data.records = await driver.getRecords(data.nrOfRecords);

          progress(100);
          return cb(null, data);
        } catch (error) {
          debug('Error in fetchData: ', error);
          return cb(error, null);
        }
      })();
    },

    processData(progress, data, cb) {
      progress(0);
      cfg.builder.setDefaults({ deviceId: cfg.deviceInfo.deviceId });
      data.post_records = [];

      // With no date & time settings changes available,
      // timezone is applied across-the-board
      cfg.tzoUtil = new TZOUtil(cfg.timezone, new Date().toISOString(), []);

      buildBGRecords(data);
      buildKetoneRecords(data);

      debug('POST records:', data.post_records);

      if (data.post_records.length === 0) {
        debug('Device has no records to upload');
        return cb(new Error('Device has no records to upload'), null);
      }
      progress(100);
      return cb(null, data);
    },

    uploadData(progress, data, cb) {
      progress(0);

      const sessionInfo = {
        deviceTags: cfg.deviceInfo.tags,
        deviceManufacturers: cfg.deviceInfo.manufacturers,
        deviceModel: cfg.deviceInfo.model,
        deviceSerialNumber: cfg.deviceInfo.serialNumber,
        deviceTime: cfg.deviceInfo.deviceTime,
        deviceId: cfg.deviceInfo.deviceId,
        start: sundial.utcDateString(),
        timeProcessing: cfg.tzoUtil.type,
        tzName: cfg.timezone,
        version: cfg.version,
      };

      cfg.api.upload.toPlatform(
        data.post_records, sessionInfo, progress, cfg.groupId,
        (err, result) => {
          progress(100);

          if (err) {
            debug(err);
            debug(result);
            return cb(err, data);
          }
          data.cleanup = true;
          return cb(null, data);
        },
        'dataservices',
      );
    },

    disconnect(progress, data, cb) {
      debug('in disconnect');
      progress(100);
      cb(null, data);
    },

    cleanup(progress, data, cb) {
      debug('in cleanup');
      if (!data.disconnect) {
        cfg.deviceComms.disconnect(data, () => {
          progress(100);
          data.cleanup = true;
          data.disconnect = true;
          cb(null, data);
        });
      } else {
        progress(100);
        cb();
      }
    },
  };
};
