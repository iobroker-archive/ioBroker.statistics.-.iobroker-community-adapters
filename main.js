'use strict';

const utils = require('@iobroker/adapter-core');
const CronJob = require('cron').CronJob;
const stateObjects = require('./lib/objects');

const PRECISION = 5;

const MIN15 = '15Min';
const HOUR = 'hour';
const DAY = 'day';
const WEEK = 'week';
const MONTH = 'month';
const QUARTER = 'quarter';
const YEAR = 'year';

// Which objects should be created (see lib/objects.js)
const nameObjects = {
    count: {
        save: [MIN15, HOUR, DAY, WEEK, MONTH, QUARTER, YEAR],
        temp: [MIN15, HOUR, DAY, WEEK, MONTH, QUARTER, YEAR, 'last5Min', 'lastPulse'],
    },
    sumCount: {
        save: [MIN15, HOUR, DAY, WEEK, MONTH, QUARTER, YEAR],
        temp: [MIN15, HOUR, DAY, WEEK, MONTH, QUARTER, YEAR, 'lastPulse'],
    },
    sumDelta: {
        save: [MIN15, HOUR, DAY, WEEK, MONTH, QUARTER, YEAR, 'delta', 'last'],
        temp: [MIN15, HOUR, DAY, WEEK, MONTH, QUARTER, YEAR],
    },
    minmax: {
        save: [
            'dayMin',
            'weekMin',
            'monthMin',
            'quarterMin',
            'yearMin',
            'dayMax',
            'weekMax',
            'monthMax',
            'quarterMax',
            'yearMax',
            'absMin',
            'absMax',
        ],
        temp: [
            'dayMin',
            'weekMin',
            'monthMin',
            'quarterMin',
            'yearMin',
            'dayMax',
            'weekMax',
            'monthMax',
            'quarterMax',
            'yearMax',
            'last',
        ],
    },
    avg: {
        save: ['15MinAvg', 'hourAvg', 'dayAvg', 'weekAvg', 'monthAvg', 'quarterAvg', 'yearAvg'],
        temp: [
            '15MinAvg',
            '15MinCount',
            'hourAvg',
            'hourCount',
            'dayAvg',
            'dayCount',
            'weekAvg',
            'weekCount',
            'monthAvg',
            'monthCount',
            'quarterAvg',
            'quarterCount',
            'yearAvg',
            'yearCount',
            'last',
        ],
    },
    timeCount: {
        save: [
            'onDay',
            'onWeek',
            'onMonth',
            'onQuarter',
            'onYear',
            'offDay',
            'offWeek',
            'offMonth',
            'offQuarter',
            'offYear',
        ],
        temp: [
            'onDay',
            'onWeek',
            'onMonth',
            'onQuarter',
            'onYear',
            'offDay',
            'offWeek',
            'offMonth',
            'offQuarter',
            'offYear',
            'last01',
            'last10',
            'last',
        ],
    },
    fiveMin: {
        save: ['mean5Min', 'dayMax5Min', 'dayMin5Min'],
        temp: ['mean5Min', 'dayMax5Min', 'dayMin5Min'],
    },
    sumGroup: {
        save: [MIN15, HOUR, DAY, WEEK, MONTH, QUARTER, YEAR],
        temp: [MIN15, HOUR, DAY, WEEK, MONTH, QUARTER, YEAR],
    },
};

const column = [MIN15, HOUR, DAY, WEEK, MONTH, QUARTER, YEAR];
const copyToSave = ['count', 'sumCount', 'sumDelta', 'sumGroup'];

function isTrue(val) {
    return val === 1 || val === '1' || val === true || val === 'true' || val === 'on' || val === 'ON';
}

function isFalse(val) {
    return (
        val === 0 ||
        val === '0' ||
        val === false ||
        val === 'false' ||
        val === 'off' ||
        val === 'OFF' ||
        val === 'standby'
    );
}

function roundValue(value, precision = 0) {
    const multiplier = Math.pow(10, precision);
    return Math.round(value * multiplier) / multiplier;
}

function timeConverter(timestamp) {
    const a = new Date(timestamp);
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const year = a.getFullYear();
    const month = months[a.getMonth()];
    const date = a.getDate();
    const hour = a.getHours();
    const min = a.getMinutes();
    const sec = a.getSeconds();

    return `${date < 10 ? ` ${date}` : date} ${month} ${year} ${hour < 10 ? `0${hour}` : hour}:${min < 10 ? `0${min}` : min}:${sec < 10 ? `0${sec}` : sec}`;
}

class Statistics extends utils.Adapter {
    constructor(options) {
        super({
            ...options,
            name: 'statistics',
        });

        this.tasks = [];
        this.taskCallback = null;
        this.tasksFinishedCallbacks = [];

        this.crons = {};

        this.groups = {};
        this.states = {}; // hold all states locally

        // to remember the used objects within the types (calculations)
        this.typeObjects = {
            sumDelta: [],
            sumGroup: [],
            avg: [],
            minmax: [],
            count: [],
            sumCount: [],
            timeCount: [],
            fiveMin: [],
        };
        this.statDP = {}; // contains all custom object definitions (with Object-ID as key)

        this.on('ready', this.onReady.bind(this));
        this.on('objectChange', this.onObjectChange.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('message', this.onMessage.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    async onReady() {
        await this.setStateAsync('info.started', { val: false, ack: true });
        // typeObjects is rebuilt after starting the adapter
        // deleting data points during runtime must be cleaned up in both arrays
        // reading the setting (here come with other setting!)
        const doc = await this.getObjectViewAsync('system', 'custom', {});

        let objCount = 0;
        if (doc && doc.rows) {
            for (let i = 0, l = doc.rows.length; i < l; i++) {
                if (doc.rows[i].value) {
                    const id = doc.rows[i].id;
                    const custom = doc.rows[i].value;
                    if (!custom || !custom[this.namespace] || !custom[this.namespace].enabled) {
                        continue;
                    }

                    this.log.info(`[SETUP] enabled statistics for ${id}`);

                    this.statDP[id] = custom[this.namespace];
                    objCount++;
                }
            }

            if (this.config.groups) {
                for (let g = 0; g < this.config.groups.length; g++) {
                    const groupConfig = this.config.groups[g];
                    const groupId = groupConfig.id;

                    if (groupId) {
                        this.groups[groupId] = { config: groupConfig, items: [] };

                        if (!this.typeObjects.sumGroup.includes(groupId)) {
                            this.typeObjects.sumGroup.push(groupId);
                        }

                        await this.defineObject(
                            'sumGroup',
                            groupId,
                            `Sum for ${groupConfig.name}`,
                            groupConfig.priceUnit,
                        );
                    } else {
                        this.log.error(
                            `Found group without id in configuration - skipping! Check your instance configuration for groups`,
                        );
                    }
                }
            }

            const keys = Object.keys(this.statDP);
            await this.setupObjects(keys);

            // subscribe to objects, so the settings in the object are arriving to the adapter
            await this.subscribeForeignObjectsAsync('*');

            this.log.info(`[SETUP] observing ${objCount} values after startup`);
        }

        // create cron-jobs
        const timezone = this.config.timezone || 'Europe/Berlin';

        // every 5min
        try {
            this.crons.fiveMin = new CronJob(
                '*/5 * * * *',
                () => this.fiveMin(),
                () => this.log.debug('stopped fiveMin'),
                true,
                timezone,
            );
        } catch (e) {
            this.log.error(`creating cron fiveMin errored with: ${e}`);
        }

        // Every 15 minutes
        try {
            this.crons.fifteenMinSave = new CronJob(
                '0,15,30,45 * * * *',
                () => this.saveValues(MIN15),
                () => this.log.debug('stopped fifteenMinSave'),
                true,
                timezone,
            );
        } catch (e) {
            this.log.error(`creating cron fifteenMinSave errored with: ${e}`);
        }

        // Hourly at 00 min
        try {
            this.crons.hourSave = new CronJob(
                '0 * * * *',
                () => this.saveValues(HOUR),
                () => this.log.debug('stopped hourSave'),
                true,
                timezone,
            );
        } catch (e) {
            this.log.error(`creating cron hourSave errored with: ${e}`);
        }

        // daily at 23:59:58
        try {
            this.crons.dayTriggerTimeCount = new CronJob(
                '58 59 23 * * *',
                () => this.setTimeCountMidnight(),
                () => this.log.debug('stopped dayTriggerTimeCount'),
                true,
                timezone,
            );
        } catch (e) {
            this.log.error(`creating cron dayTriggerTimeCount errored with: ${e}`);
        }

        // daily at 00:00
        try {
            this.crons.daySave = new CronJob(
                '0 0 * * *',
                () => this.saveValues(DAY),
                () => this.log.debug('stopped daySave'),
                true,
                timezone,
            );
        } catch (e) {
            this.log.error(`creating cron daySave errored with: ${e}`);
        }

        // Monday 00:00
        try {
            this.crons.weekSave = new CronJob(
                '0 0 * * 1',
                () => this.saveValues(WEEK),
                () => this.log.debug('stopped weekSave'),
                true,
                timezone,
            );
        } catch (e) {
            this.log.error(`creating cron weekSave errored with: ${e}`);
        }

        // Monthly at 1st of every month at 00:00
        try {
            this.crons.monthSave = new CronJob(
                '0 0 1 * *',
                () => this.saveValues(MONTH),
                () => this.log.debug('stopped monthSave'),
                true,
                timezone,
            );
        } catch (e) {
            this.log.error(`creating cron monthSave errored with: ${e}`);
        }

        // Quarterly at 1st of every quarter at 00:00
        try {
            this.crons.quarterSave = new CronJob(
                '0 0 1 1,4,7,10 *',
                () => this.saveValues(QUARTER),
                () => this.log.debug('stopped quarterSave'),
                true,
                timezone,
            );
        } catch (e) {
            this.log.error(`creating cron quarterSave errored with: ${e}`);
        }

        // New year at 1st of every year at 00:00
        try {
            this.crons.yearSave = new CronJob(
                '0 0 1 1 *',
                () => this.saveValues(YEAR),
                () => this.log.debug('stopped yearSave'),
                true,
                timezone,
            );
        } catch (e) {
            this.log.error(`creating cron yearSave errored with: ${e}`);
        }

        for (const type in this.crons) {
            if (Object.prototype.hasOwnProperty.call(this.crons, type) && this.crons[type]) {
                this.log.debug(
                    `[SETUP] ${type} status = "${this.crons[type].running ? 'running' : 'error'}", next event: ${timeConverter(this.crons[type].nextDate())}`,
                );
            }
        }

        await this.setStateAsync('info.started', { val: true, ack: true });
    }

    /**
     * @param {string} id
     * @param {ioBroker.Object | null | undefined} obj
     */
    onObjectChange(id, obj) {
        const isStart = !this.tasks.length;

        this.tasks.push({
            name: 'promise',
            args: { id, obj },
            callback: async args => {
                // Warning, obj can be null if it was deleted
                if (args?.obj?.common?.custom?.[this.namespace] && args.obj.common.custom[this.namespace]?.enabled) {
                    this.log.debug(`[OBJECT CHANGE] stat "${args.id}": ${JSON.stringify(args.obj.common.custom)}`);

                    // old but changed
                    if (this.statDP[args.id]) {
                        const newObj = args.obj.common.custom[this.namespace];
                        this.statDP[args.id] = newObj;

                        // Delete objects of unspecified types
                        Object.keys(this.typeObjects).forEach(type => {
                            if (!newObj[type]) {
                                this.delObject(`save.${type}.${args.id}`, { recursive: true });
                                this.delObject(`temp.${type}.${args.id}`, { recursive: true });
                            }
                        });

                        this.removeObject(args.id);
                        this.setupObjects([args.id]);
                        this.log.debug(
                            `[OBJECT CHANGE] saved (updated) typeObject of stat "${args.id}": ${JSON.stringify(this.statDP[args.id])}`,
                        );
                    } else {
                        this.statDP[args.id] = args.obj.common.custom[this.namespace];
                        this.setupObjects([args.id]);
                        this.log.debug(
                            `[OBJECT CHANGE] saved (new) typeObjects of stat "${args.id}": ${JSON.stringify(this.statDP[args.id])}`,
                        );
                    }
                } else if (this.statDP[args.id]) {
                    this.log.debug(
                        `[OBJECT CHANGE] removing typeObjects of stat "${args.id}": ${JSON.stringify(this.statDP[args.id])}`,
                    );

                    // Delete objects of all types
                    Object.keys(this.typeObjects).forEach(type => {
                        this.delObject(`save.${type}.${args.id}`, { recursive: true });
                        this.delObject(`temp.${type}.${args.id}`, { recursive: true });
                    });

                    delete this.statDP[args.id];
                    this.removeObject(args.id);
                    this.unsubscribeForeignObjects(args.id);
                    this.unsubscribeForeignStates(args.id);
                }
            },
        });

        isStart && this.processTasks();
    }

    /**
     * @param {string} id
     * @param {ioBroker.State | null | undefined} state
     */
    onStateChange(id, state) {
        const isStart = !this.tasks.length;

        if (id && state && state.ack) {
            this.tasks.push({
                name: 'promise',
                args: { id, state },
                callback: async args => {
                    this.log.debug(`[STATE CHANGE] ======================= ${args.id} =======================`);
                    this.log.debug(`[STATE CHANGE] stateChange => ${args.state.val}`);

                    if (args.state.val === null || args.state.val === undefined || isNaN(args.state.val)) {
                        this.log.warn(
                            `[STATE CHANGE] wrong value => ${args.state.val} on ${args.id} => check the other adapter where value comes from `,
                        );
                    } else {
                        if (this.typeObjects.sumDelta.includes(args.id)) {
                            this.log.debug(`[STATE CHANGE] schedule onStateChangeSumDeltaValue for ${args.id}`);
                            this.onStateChangeSumDeltaValue(args.id, args.state.val);
                        } else if (this.typeObjects.avg.includes(args.id)) {
                            this.log.debug(`[STATE CHANGE] schedule onStateChangeAvgValue for ${args.id}`);
                            this.onStateChangeAvgValue(args.id, args.state.val);
                        }

                        if (this.typeObjects.minmax.includes(args.id)) {
                            this.log.debug(`[STATE CHANGE] schedule onStateChangeMinMaxValue for ${args.id}`);
                            this.onStateChangeMinMaxValue(args.id, args.state.val);
                        }

                        if (this.typeObjects.count.includes(args.id)) {
                            this.log.debug(`[STATE CHANGE] schedule onStateChangeCountValue for ${args.id}`);
                            this.onStateChangeCountValue(args.id, args.state.val);
                        }

                        if (this.typeObjects.sumCount.includes(args.id)) {
                            this.log.debug(`[STATE CHANGE] schedule onStateChangeSumCountValue for ${args.id}`);
                            this.onStateChangeSumCountValue(args.id, args.state.val);
                        }

                        if (this.typeObjects.timeCount.includes(args.id)) {
                            this.log.debug(`[STATE CHANGE] schedule onStateChangeTimeCntValue for ${args.id}`);
                            this.onStateChangeTimeCntValue(args.id, args.state);
                        }

                        // 5min is treated cyclically
                    }
                },
            });
        }

        isStart && this.processTasks();
    }

    /**
     * @param {ioBroker.Message} msg
     */
    onMessage(msg) {
        this.log.debug(`[onMessage] Received ${JSON.stringify(msg)}`);

        if (msg.command === 'groups' && msg.callback) {
            this.sendTo(
                msg.from,
                msg.command,
                (this.config.groups || []).map(item => ({ label: item.name, value: item.id })),
                msg.callback,
            );
        } else if (msg.command === 'getCrons') {
            this.sendTo(
                msg.from,
                msg.command,
                Object.keys(this.crons).map(item => ({
                    label: item,
                    value: new Date(this.crons[item].nextDate()).getTime(),
                })),
                msg.callback,
            );
        } else if (msg.command === 'enableStatistics') {
            if (typeof msg.message === 'object' && msg.message?.id) {
                const objId = msg.message.id;

                this.getForeignObject(objId, (err, obj) => {
                    if (err || !obj) {
                        this.sendTo(
                            msg.from,
                            msg.command,
                            {
                                success: false,
                                err: `Unable to get object with ID ${objId}`,
                            },
                            msg.callback,
                        );
                    } else {
                        if (obj?.type === 'state') {
                            const objCustomOptions = {
                                common: {
                                    custom: {},
                                },
                            };

                            const objCustomDefaults = {
                                enabled: true,

                                // for boolean states
                                count: false,
                                fiveMin: false, // requires .count = true
                                sumCount: false,
                                impUnitPerImpulse: 1, // requires .sumCount = true
                                impUnit: '', // requires .sumCount = true
                                timeCount: false,

                                // for number states
                                avg: false,
                                minmax: false,
                                sumDelta: false,
                                sumIgnoreMinus: false,

                                sumGroup: undefined, // requires .sumCount = true or .sumDelta = true
                                groupFactor: 1, // requres sumGroup

                                logName: String(obj._id).split('.').pop(),
                            };

                            if (typeof msg.message === 'object' && typeof msg.message?.options === 'object') {
                                objCustomOptions.common.custom[this.namespace] = {
                                    ...objCustomDefaults,
                                    ...msg.message.options,
                                };
                            } else {
                                objCustomOptions.common.custom[this.namespace] = {
                                    ...objCustomDefaults,
                                    count: obj.common.type === 'boolean',
                                    avg: obj.common.type === 'number',
                                };
                            }

                            this.log.debug(
                                `Extending state ${JSON.stringify(obj)} with ${JSON.stringify(objCustomOptions)}`,
                            );
                            this.extendForeignObject(objId, objCustomOptions, err => {
                                if (err) {
                                    this.log.error(`enableStatistics of ${objId} failed: ${err}`);
                                    this.sendTo(
                                        msg.from,
                                        msg.command,
                                        {
                                            success: false,
                                            err: err,
                                        },
                                        msg.callback,
                                    );
                                } else {
                                    this.sendTo(
                                        msg.from,
                                        msg.command,
                                        {
                                            success: true,
                                            err: null,
                                        },
                                        msg.callback,
                                    );
                                }
                            });
                        } else {
                            this.sendTo(
                                msg.from,
                                msg.command,
                                {
                                    success: false,
                                    err: `Object with ID ${objId} is not a state: ${obj?.type}`,
                                },
                                msg.callback,
                            );
                        }
                    }
                });
            } else {
                this.sendTo(
                    msg.from,
                    msg.command,
                    {
                        success: false,
                        err: `Configuration missing - please set at least { id: 'your.object.id' }`,
                    },
                    msg.callback,
                );
            }
        } else if (msg.command === 'saveValues') {
            // Used for integration tests
            if (msg.message?.period && column.includes(msg.message.period)) {
                this.saveValues(msg.message.period);
                this.sendTo(msg.from, msg.command, { success: true, period: msg.message.period }, msg.callback);
            } else {
                this.sendTo(msg.from, msg.command, { success: false, err: 'invalid time period' }, msg.callback);
            }
        }
    }

    /**
     * @param {() => void} callback
     */
    onUnload(callback) {
        try {
            this.setStateAsync('info.started', { val: false, ack: true });
            this.setStateAsync('info.working', { val: false, ack: true });

            // possibly also delete a few schedules
            for (const type in this.crons) {
                if (Object.prototype.hasOwnProperty.call(this.crons, type) && this.crons[type]) {
                    this.crons[type].stop();
                    this.crons[type] = null;
                }
            }

            this.log.info('cleaned everything up...');

            callback();
        } catch {
            callback();
        }
    }

    async isTrueNew(id, val, type) {
        // detection if a count value is real or only from polling with same state
        let newPulse = false;
        const value = await this.getValueAsync(`temp.${type}.${id}.lastPulse`);
        await this.setValueAsync(`temp.${type}.${id}.lastPulse`, val);

        if (value === val) {
            newPulse = false;
            this.log.debug(`new pulse false ? ${newPulse}`);
        } else {
            newPulse = isTrue(val);
            this.log.debug(`new pulse true ? ${newPulse}`);
        }

        return newPulse;
    }

    async getValueAsync(id) {
        return new Promise((resolve, reject) => {
            if (Object.prototype.hasOwnProperty.call(this.states, id)) {
                resolve(this.states[id].val);
            } else {
                this.getState(id, (err, state) => {
                    if (err) {
                        reject(err);
                    }

                    this.states[id] = state ? { val: state.val, ts: state.ts } : null;

                    resolve(this.states[id].val);
                });
            }
        });
    }

    async setValueAsync(id, value) {
        return new Promise((resolve, reject) => {
            const ts = Date.now();
            this.states[id] = { val: value, ts };
            this.setState(id, { val: value, ts, ack: true }, err => {
                if (err) {
                    reject(err);
                }

                resolve(value);
            });
        });
    }

    async setValueStatAsync(id, value) {
        return new Promise((resolve, reject) => {
            const ts = new Date();
            ts.setMinutes(ts.getMinutes() - 1);
            ts.setSeconds(59);
            ts.setMilliseconds(0);

            this.states[id] = { val: value, ts: ts.getTime() };
            this.setState(id, { val: value, ts: ts.getTime(), ack: true }, err => {
                if (err) {
                    reject(err);
                }

                resolve(value);
            });
        });
    }

    checkValue(value, ts, id, type) {
        const now = new Date();
        now.setSeconds(0);
        now.setMilliseconds(0);

        if (type === MIN15) {
            // value may not be older than 15 min
            now.setMinutes(now.getMinutes() - (now.getMinutes() % 15));
        } else if (type === HOUR) {
            // value may not be older than full hour
            now.setMinutes(0);
        } else if (type === DAY) {
            // value may not be older than 00:00 of today
            now.setMinutes(0);
            now.setHours(0);
        } else if (type === WEEK) {
            // value may not be older than 00:00 of today
            now.setMinutes(0);
            now.setHours(0);
        } else if (type === MONTH) {
            // value may not be older than 00:00 of today
            now.setMinutes(0);
            now.setHours(0);
            now.setDate(1);
        } else if (type === QUARTER) {
            // value may not be older than 00:00 of today
            now.setMinutes(0);
            now.setHours(0);
            now.setDate(1);
            // 0, 3, 6, 9
            now.setMonth(now.getMonth() - (now.getMonth() % 3));
        } else if (type === YEAR) {
            // value may not be older than 1 Januar of today
            now.setMinutes(0);
            now.setHours(0);
            now.setDate(1);
            now.setMonth(0);
        } else {
            this.log.error(`Unknown calc type: ${type}`);
            return value;
        }

        if (ts < now.getTime()) {
            this.log.warn(`[STATE CHANGE] Value of ${id} ignored because older than ${now.toISOString()}`);
            value = 0;
        }

        return value;
    }

    async copyValue(sourceId, targetId) {
        let value = await this.getValueAsync(sourceId);

        if (value !== null && value !== undefined) {
            this.log.debug(`[SAVE VALUES] Process ${sourceId} = ${value}`);
            value = value || 0; // protect against NaN

            await this.setValueStatAsync(targetId, value);
            await this.setValueAsync(sourceId, 0);
        } else {
            this.log.debug(`[SAVE VALUES] Process ${targetId} => no value found`);
        }
    }

    async copyValueActMinMax(args) {
        let value = await this.getValueAsync(args.temp);

        if (value !== null && value !== undefined) {
            this.log.debug(`[SAVE VALUES] Process ${args.temp} = ${value} to ${args.save}`);
            value = value || 0; // protect against NaN

            await this.setValueStatAsync(args.save, value);
            const actual = await this.getValueAsync(args.actual);

            this.log.debug(`[SET DAILY START MINMAX] Process ${args.temp} = ${actual} from ${args.actual}`);
            await this.setValueAsync(args.temp, actual);

            return true;
        }
        this.log.debug(`[SAVE VALUES & SET DAILY START MINMAX] Process ${args.temp} => no value found`);
        return false;
    }

    setTimeCountMidnight() {
        if (this.typeObjects.timeCount) {
            for (let s = 0; s < this.typeObjects.timeCount.length; s++) {
                const id = this.typeObjects.timeCount[s];
                // bevor umgespeichert wird, muß noch ein Aufruf mit actual erfolgen, damit die restliche Zeit vom letzten Signalwechsel bis Mitternacht erfolgt
                // aufruf von newTimeCntValue(id, "last") damit wird gleicher Zustand getriggert und last01 oder last10 zu Mitternacht neu gesetzt
                this.getState(`temp.timeCount.${id}.last`, (err, last) => {
                    //hier muss nur id stehen, dann aber noch Beachtung des Timestamps
                    //evtl. status ermitteln und dann setForeignState nochmals den Zustand schreiben um anzutriggern und aktuelle Zeit zu verwenden (bzw. 00:00:00)
                    const ts = new Date();
                    //ts.setMinutes(ts.getMinutes() - 1);
                    //ts.setSeconds(59);
                    //ts.setMilliseconds(0);
                    if (last) {
                        last.ts = ts.getTime();
                        this.onStateChangeTimeCntValue(id, last);
                    }
                });
            }
        }
    }

    async setupObjects(ids) {
        for (const id of ids) {
            const obj = this.statDP[id];

            if (obj.groupFactor && obj.groupFactor !== '0' && obj.groupFactor !== 0) {
                obj.groupFactor = parseFloat(obj.groupFactor) || this.config.impFactor;
            } else {
                obj.groupFactor = this.config.impFactor; // Default from config if 0
            }

            if (obj.impUnitPerImpulse && obj.impUnitPerImpulse !== '0' && obj.impUnitPerImpulse !== 0) {
                obj.impUnitPerImpulse = parseFloat(obj.impUnitPerImpulse) || this.config.impUnitPerImpulse;
            } else {
                obj.impUnitPerImpulse = this.config.impUnitPerImpulse; // Default from config if 0
            }

            const sourceObj = await this.getForeignObjectAsync(id);
            const sourceUnit = sourceObj?.type === 'state' && sourceObj?.common?.unit;

            // function is called with the custom objects
            this.log.debug(`[CREATION] ============================== ${id} =============================`);
            this.log.debug(`[CREATION] setup of object "${id}": ${JSON.stringify(obj)}`);
            const logName = obj.logName;

            // count
            if (obj.count) {
                this.log.debug(`[CREATION] count: ${id}`);

                if (!this.typeObjects.count.includes(id)) {
                    this.typeObjects.count.push(id);
                }

                await this.defineObject('count', id, logName);
            }

            // sumCount
            if (obj.sumCount) {
                this.log.debug(`[CREATION] sumCount: ${id}`);

                if (!this.typeObjects.sumCount.includes(id)) {
                    this.typeObjects.sumCount.push(id);
                }

                await this.defineObject('sumCount', id, logName, obj.impUnit);
            }

            // sumDelta
            if (obj.sumDelta) {
                this.log.debug(`[CREATION] sumDelta: ${id}`);

                if (!this.typeObjects.sumDelta.includes(id)) {
                    this.typeObjects.sumDelta.push(id);
                }

                await this.defineObject('sumDelta', id, logName, sourceUnit);
            }

            // minMax
            if (obj.minmax) {
                this.log.debug(`[CREATION] minmax: ${id}`);

                if (!this.typeObjects.minmax.includes(id)) {
                    this.typeObjects.minmax.push(id);
                }

                await this.defineObject('minmax', id, logName, sourceUnit);
            }

            // avg
            if (obj.avg) {
                this.log.debug(`[CREATION] avg: ${id}`);

                if (!this.typeObjects.avg.includes(id)) {
                    this.typeObjects.avg.push(id);
                }

                await this.defineObject('avg', id, logName, sourceUnit);
            }

            // timeCount
            if (obj.timeCount) {
                this.log.debug(`[CREATION] timeCount: ${id}`);

                if (!this.typeObjects.timeCount.includes(id)) {
                    this.typeObjects.timeCount.push(id);
                }

                await this.defineObject('timeCount', id, logName);
            }

            // fiveMin
            if (obj.fiveMin && obj.count) {
                this.log.debug(`[CREATION] fiveMin: ${id}`);

                if (!this.typeObjects.fiveMin.includes(id)) {
                    this.typeObjects.fiveMin.push(id);
                }

                await this.defineObject('fiveMin', id, logName);
            }

            // sumGroup
            if (obj.sumGroup && (obj.sumCount || obj.sumDelta) && this.groups[obj.sumGroup]) {
                if (!this.groups[obj.sumGroup].items.includes(id)) {
                    this.groups[obj.sumGroup].items.push(id);
                }
            }

            await this.subscribeForeignStatesAsync(id);
        }
    }

    removeObject(id) {
        Object.keys(this.states).forEach(key => {
            if (key.indexOf(id) > -1) {
                this.log.debug(`[DELETE] Removing "${key}" from value cache`);
                delete this.states[key];
            }
        });

        Object.keys(this.typeObjects).forEach(type => {
            if (Array.isArray(this.typeObjects[type])) {
                this.typeObjects[type] = this.typeObjects[type].filter(typeId => typeId !== id);
            }
        });

        Object.keys(this.groups).forEach(g => {
            if (this.groups[g].items && Array.isArray(this.groups[g].items)) {
                this.groups[g].items = this.groups[g].items.filter(groupId => groupId !== id);
            } else {
                this.log.error(`Invalid structure of group "${g}": ${JSON.stringify(this.groups[g])}`);
            }
        });
    }

    saveValues(timePeriod) {
        const isStart = !this.tasks.length;
        const dayTypes = [];

        for (const key in this.typeObjects) {
            if (this.typeObjects[key].length && copyToSave.includes(key)) {
                dayTypes.push(key);
            }
        }

        this.log.debug(`[SAVE VALUES] saving ${timePeriod} values: ${dayTypes.join(', ')}`);

        const tp = column.indexOf(timePeriod); // nameObjects[day] contains the time-related object value

        // count, sumCount, sumDelta, sumGroup
        for (let t = 0; t < dayTypes.length; t++) {
            for (let s = 0; s < this.typeObjects[dayTypes[t]].length; s++) {
                const nameObjId = nameObjects[dayTypes[t]].temp[tp];
                // ignore last5min
                if (nameObjId === 'last5Min') {
                    continue;
                }
                const id = this.typeObjects[dayTypes[t]][s];
                this.tasks.push({
                    name: 'promise',
                    args: {
                        temp: `temp.${dayTypes[t]}.${id}.${nameObjId}`,
                        save: `save.${dayTypes[t]}.${id}.${nameObjId}`,
                    },
                    callback: async args => {
                        await this.copyValue(args.temp, args.save);
                    },
                });
            }
        }

        // avg
        if (this.typeObjects.avg) {
            for (let s = 0; s < this.typeObjects.avg.length; s++) {
                this.tasks.push({
                    name: 'promise',
                    args: {
                        id: this.typeObjects.avg[s],
                        timePeriod: timePeriod,
                    },
                    callback: async args => {
                        await this.copyValue(
                            `temp.avg.${args.id}.${timePeriod}Avg`,
                            `save.avg.${args.id}.${timePeriod}Avg`,
                        );

                        const prevValue = await this.getValueAsync(`temp.avg.${args.id}.last`);

                        await this.setValueStatAsync(`temp.avg.${args.id}.${timePeriod}Avg`, prevValue);
                        await this.setValueStatAsync(`temp.avg.${args.id}.${timePeriod}Count`, 1);
                    },
                });
            }
        }

        // fiveMin
        if (timePeriod === DAY && this.typeObjects.fiveMin) {
            for (let s = 0; s < this.typeObjects.fiveMin.length; s++) {
                const id = this.typeObjects.fiveMin[s];

                this.tasks.push({
                    name: 'promise',
                    args: {
                        temp: `temp.fiveMin.${id}.dayMin5Min`,
                        save: `save.fiveMin.${id}.dayMin5Min`,
                    },
                    callback: async args => {
                        await this.copyValue(args.temp, args.save);
                    },
                });

                this.tasks.push({
                    name: 'promise',
                    args: {
                        temp: `temp.fiveMin.${id}.dayMax5Min`,
                        save: `save.fiveMin.${id}.dayMax5Min`,
                    },
                    callback: async args => {
                        await this.copyValue(args.temp, args.save);
                    },
                });
            }
        }

        // timeCount
        // DAY, WEEK, MONTH, QUARTER, YEAR
        if (tp >= 2) {
            if (this.typeObjects.timeCount) {
                for (let s = 0; s < this.typeObjects.timeCount.length; s++) {
                    const id = this.typeObjects.timeCount[s];

                    this.tasks.push({
                        name: 'promise',
                        args: {
                            temp: `temp.timeCount.${id}.${nameObjects.timeCount.temp[tp - 2]}`, // 0 is onDay
                            save: `save.timeCount.${id}.${nameObjects.timeCount.temp[tp - 2]}`,
                        },
                        callback: async args => {
                            await this.copyValue(args.temp, args.save);
                        },
                    });

                    this.tasks.push({
                        name: 'promise',
                        args: {
                            temp: `temp.timeCount.${id}.${nameObjects.timeCount.temp[tp + 3]}`, // +5 is offDay
                            save: `save.timeCount.${id}.${nameObjects.timeCount.temp[tp + 3]}`,
                        },
                        callback: async args => {
                            await this.copyValue(args.temp, args.save);
                        },
                    });
                }
            }
        }

        // minmax
        // DAY, WEEK, MONTH, QUARTER, YEAR
        if (tp >= 2) {
            if (this.typeObjects.minmax) {
                for (let s = 0; s < this.typeObjects.minmax.length; s++) {
                    const id = this.typeObjects.minmax[s];
                    this.tasks.push({
                        name: 'promise',
                        args: {
                            temp: `temp.minmax.${id}.${nameObjects.minmax.temp[tp - 2]}`, // 0 ist minDay
                            save: `save.minmax.${id}.${nameObjects.minmax.temp[tp - 2]}`,
                            actual: `temp.minmax.${id}.last`,
                        },
                        callback: this.copyValueActMinMax.bind(this),
                    });
                    this.tasks.push({
                        name: 'promise',
                        args: {
                            temp: `temp.minmax.${id}.${nameObjects.minmax.temp[tp + 3]}`, // +5 ist maxDay
                            save: `save.minmax.${id}.${nameObjects.minmax.temp[tp + 3]}`,
                            actual: `temp.minmax.${id}.last`,
                        },
                        callback: this.copyValueActMinMax.bind(this),
                    });
                }
            }
        }

        isStart && this.processTasks();
    }

    async defineObject(type, id, name, unit) {
        // Workaround for untranslated objects
        if (typeof name !== 'object') {
            name = {
                en: name,
            };
        }

        // Create save channel
        await this.setObjectNotExistsAsync(`save.${type}.${id}`, {
            type: 'channel',
            common: {
                name: {
                    en: `Saved values for ${name.en}`,
                    de: `Gespeicherte Werte für ${name.de ?? name.en}`,
                    ru: `Сохраненные значения для ${name.ru ?? name.en}`,
                    pt: `Valores salvos para ${name.pt ?? name.en}`,
                    nl: `Bespaarde waarden voor ${name.nl ?? name.en}`,
                    fr: `Valeurs sauvegardées pour ${name.fr ?? name.en}`,
                    it: `Valori salvati per ${name.it ?? name.en}`,
                    es: `Valores guardados para ${name.es ?? name.en}`,
                    pl: `Oszczędne wartości dla ${name.pl ?? name.en}`,
                    uk: `Збережені значення для ${name.uk ?? name.en}`,
                    'zh-cn': `保存的价值 ${name['zh-cn'] ?? name.en}`,
                },
            },
            native: {
                addr: id,
            },
        });

        // Create temp channel
        await this.setObjectNotExistsAsync(`temp.${type}.${id}`, {
            type: 'channel',
            common: {
                name: {
                    en: `Temporary values for ${name.en}`,
                    de: `Vorläufige Werte für ${name.de ?? name.en}`,
                    ru: `Временные значения для ${name.ru ?? name.en}`,
                    pt: `Valores temporários para ${name.pt ?? name.en}`,
                    nl: `Tijdelijke waarden voor ${name.nl ?? name.en}`,
                    fr: `Valeurs temporaires pour ${name.fr ?? name.en}`,
                    it: `Valori temporanei per ${name.it ?? name.en}`,
                    es: `Valores temporales para ${name.es ?? name.en}`,
                    pl: `Temporary wartości dla ${name.pl ?? name.en}`,
                    uk: `Тимчасові значення для ${name.uk ?? name.en}`,
                    'zh-cn': `${name['zh-cn'] ?? name.en} 的临时值`,
                },
            },
            native: {
                addr: id,
            },
        });

        // states for the saved values
        let objects = nameObjects[type].save;
        for (let s = 0; s < objects.length; s++) {
            if (!stateObjects[objects[s]]) {
                this.log.error(`[CREATION] State ${objects[s]} unknown`);
                continue;
            }
            const obj = JSON.parse(JSON.stringify(stateObjects[objects[s]]));
            if (!obj) {
                this.log.error(`[CREATION] Unknown state: ${objects[s]}`);
                continue;
            }

            obj.native.addr = id;

            if (unit && !['dayCount'].includes(objects[s])) {
                obj.common.unit = unit;
            }

            await this.extendObject(`save.${type}.${id}.${objects[s]}`, obj);
        }

        // states for the temporary values
        objects = nameObjects[type].temp;
        for (let s = 0; s < objects.length; s++) {
            if (!stateObjects[objects[s]]) {
                this.log.error(`[CREATION] State ${objects[s]} unknown`);
                continue;
            }

            const obj = JSON.parse(JSON.stringify(stateObjects[objects[s]]));
            if (!obj) {
                this.log.error(`[CREATION] Unknown state: ${objects[s]}`);
                continue;
            }

            obj.native.addr = id;

            if (unit && !['dayCount', 'lastPulse'].includes(objects[s])) {
                obj.common.unit = unit;
            }

            await this.extendObject(`temp.${type}.${id}.${objects[s]}`, obj);
        }

        // Delete old sum states
        const oldStates = ['15MinAvg', '15MinSum', 'hourSum', 'daySum', 'weekSum', 'monthSum', 'quarterSum', 'yearSum'];
        for (const oldStateId of oldStates) {
            await this.delObjectAsync(`temp.${type}.${id}.${oldStateId}`);
        }

        await this.setInitial(type, id);
    }

    async setInitial(type, id) {
        const saveObjects = nameObjects[type].save;

        for (let s = 0; s < saveObjects.length; s++) {
            const name = saveObjects[s];

            const targetId = `save.${type}.${id}.${name}`;
            const currentVal = await this.getValueAsync(targetId);

            if (currentVal === null) {
                this.log.debug(`[SET INITIAL] "${id}" -> "${targetId}"`);

                if (type === 'count') {
                    await this.setValueAsync(targetId, 0);
                } else if (type === 'sumCount') {
                    await this.setValueAsync(targetId, 0);
                } else if (type === 'sumDelta') {
                    if (name === 'last') {
                        const sumDeltaInitVal = await this.getForeignStateAsync(id);

                        if (sumDeltaInitVal && sumDeltaInitVal.val) {
                            this.log.debug(`[SET INITIAL] "${id}" sumDelta init value: ${sumDeltaInitVal.val}`);
                            await this.setValueAsync(targetId, sumDeltaInitVal.val);
                        }
                    } else if (name === 'delta') {
                        await this.setValueAsync(targetId, 0);
                    } else {
                        await this.setValueAsync(targetId, 0);
                    }
                } else if (type === 'minmax') {
                    const minmaxInitVal = await this.getForeignStateAsync(id);

                    if (minmaxInitVal && minmaxInitVal.val !== null) {
                        this.log.debug(`[SET INITIAL] ${id} minmax init value: ${minmaxInitVal.val}`);
                        await this.setValueAsync(targetId, minmaxInitVal.val);
                    }
                } else if (type === 'timeCount') {
                    await this.setValueAsync(targetId, 0);
                } else if (type === 'sumGroup') {
                    await this.setValueAsync(targetId, 0);
                }
            }
        }

        const tempObjects = nameObjects[type].temp;
        for (let s = 0; s < tempObjects.length; s++) {
            const name = tempObjects[s];

            const targetId = `temp.${type}.${id}.${name}`;
            const currentVal = await this.getValueAsync(targetId);

            if (currentVal === null) {
                this.log.debug(`[SET INITIAL] "${id}" -> "${targetId}"`);

                if (type === 'count') {
                    const countInitVal = await this.getForeignStateAsync(id);

                    if (name === 'lastPulse') {
                        if (countInitVal && countInitVal.val !== null) {
                            if (isTrue(countInitVal.val) || isFalse(countInitVal.val)) {
                                this.log.debug(`[SET INITIAL] "${id}" count init value: ${countInitVal.val}`);
                                await this.setValueAsync(targetId, countInitVal.val);
                            } else {
                                this.log.error(`[SET INITIAL] "${id}" unknown state to be evaluated in count`);
                            }
                        }
                    } else {
                        await this.setValueAsync(targetId, 0);
                    }
                } else if (type === 'sumCount') {
                    const sumCountInitVal = await this.getForeignStateAsync(id);

                    if (name === 'lastPulse') {
                        if (sumCountInitVal && sumCountInitVal.val !== null) {
                            if (isTrue(sumCountInitVal.val) || isFalse(sumCountInitVal.val)) {
                                this.log.debug(`[SET INITIAL] "${id}" sumCount init value: ${sumCountInitVal.val}`);
                                await this.setValueAsync(targetId, sumCountInitVal.val);
                            } else {
                                this.log.error(`[SET INITIAL] "${id}" unknown state to be evaluated in sumCount`);
                            }
                        }
                    } else {
                        await this.setValueAsync(targetId, 0);
                    }
                } else if (type === 'sumDelta') {
                    await this.setValueAsync(targetId, 0);
                } else if (type === 'minmax') {
                    const minmaxInitVal = await this.getForeignStateAsync(id);

                    if (minmaxInitVal && minmaxInitVal.val !== null) {
                        this.log.debug(`[SET INITIAL] ${id} minmax init value: ${minmaxInitVal.val}`);
                        await this.setValueAsync(targetId, minmaxInitVal.val);
                    }
                } else if (type === 'avg') {
                    const avgInitVal = await this.getForeignStateAsync(id);

                    if (avgInitVal && avgInitVal.val !== null) {
                        if (name.indexOf('Count') > -1) {
                            this.log.debug(`[SET INITIAL] ${id} avg init value: 1`);
                            await this.setValueAsync(targetId, 1);
                        } else {
                            this.log.debug(`[SET INITIAL] ${id} avg init value: ${avgInitVal.val}`);
                            await this.setValueAsync(targetId, avgInitVal.val);
                        }
                    }
                } else if (type === 'timeCount') {
                    if (['last01', 'last10', 'last'].includes(name)) {
                        const timeCountInitVal = await this.getForeignStateAsync(id);

                        if (name === 'last01') {
                            if (timeCountInitVal && timeCountInitVal.val !== null) {
                                if (isFalse(timeCountInitVal.val)) {
                                    this.log.debug(`[SET INITIAL] "${id}" timeCount init value: NOW`);
                                    await this.setValueAsync(targetId, Date.now());
                                } else if (isTrue(timeCountInitVal.val)) {
                                    this.log.debug(
                                        `[SET INITIAL] "${id}" timeCount init value: ${timeCountInitVal.lc}`,
                                    );
                                    await this.setValueAsync(targetId, timeCountInitVal.lc);
                                } else {
                                    this.log.error(`[SET INITIAL] "${id}" unknown state to be evaluated in timeCount`);
                                }
                            }
                        } else if (name === 'last10') {
                            if (timeCountInitVal && timeCountInitVal.val !== null) {
                                if (isFalse(timeCountInitVal.val)) {
                                    this.log.debug(
                                        `[SET INITIAL] "${id}" timeCount init value: ${timeCountInitVal.lc}`,
                                    );
                                    await this.setValueAsync(targetId, timeCountInitVal.lc);
                                } else if (isTrue(timeCountInitVal.val)) {
                                    this.log.debug(`[SET INITIAL] "${id}" timeCount init value: NOW`);
                                    await this.setValueAsync(targetId, Date.now());
                                } else {
                                    this.log.error(`[SET INITIAL] "${id}" unknown state to be evaluated in timeCount`);
                                }
                            }
                        } else if (name === 'last') {
                            if (timeCountInitVal && timeCountInitVal.val !== null) {
                                if (isTrue(timeCountInitVal.val) || isFalse(timeCountInitVal.val)) {
                                    this.log.debug(
                                        `[SET INITIAL] "${id}" timeCount init value: ${timeCountInitVal.val}`,
                                    );
                                    await this.setValueAsync(targetId, timeCountInitVal.val);
                                } else {
                                    this.log.error(`[SET INITIAL] "${id}" unknown state to be evaluated in timeCount`);
                                }
                            }
                        }
                    } else {
                        await this.setValueAsync(targetId, 0);
                    }
                } else if (type === 'sumGroup') {
                    await this.setValueAsync(targetId, 0);
                }
            }
        }
    }

    processNext() {
        this.tasks.shift();
        setImmediate(this.processTasks.bind(this));
    }

    processTasks(callback) {
        if (callback) {
            this.tasksFinishedCallbacks.push(callback);
        }

        if (!this.tasks || !this.tasks.length) {
            if (this.taskCallback) {
                const cb = this.taskCallback;
                this.taskCallback = null;
                cb();
            }

            const processCallbacks = this.tasksFinishedCallbacks;
            this.tasksFinishedCallbacks = [];
            processCallbacks.forEach(cb => setImmediate(cb));

            this.setStateChangedAsync('info.working', { val: false, ack: true });
            return;
        }
        this.setStateChangedAsync('info.working', { val: true, ack: true });

        const task = this.tasks[0];
        if (task.name === 'promise') {
            if (typeof task.callback === 'function') {
                task.callback(task.args).then(() => {
                    this.processNext();
                });
            } else {
                this.log.error('[processTasks] error async task');
                this.processNext();
            }
        }
    }

    fiveMin() {
        /**
         * Determine 5min values
         *
         * Get current min from temp
         * Get current max from temp
         * current value from the monitored counter
         * old value (before 5min) from the monitored counter
         *
         * determination delta and decision whether new min / max is stored
         * current counter reading is written in the old value
         *
         * typeObjects.fiveMin [t] contains the objectId of the monitored counter
         *
         */

        // go through all subscribed objects and write
        if (this.typeObjects.fiveMin) {
            this.log.debug('[5 MINUTES] evaluation');

            const isStart = !this.tasks.length;

            for (let t = 0; t < this.typeObjects.fiveMin.length; t++) {
                this.tasks.push({
                    name: 'promise',
                    args: { id: this.typeObjects.fiveMin[t] },
                    callback: async args => {
                        this.log.debug(`[EXECUTING] fiveMin call ${args.id}`);

                        if (!this.statDP[args.id]) {
                            this.log.warn(`[ABORTING] fiveMin call ${args.id} - object no longer exists`);
                            return false;
                        }

                        const temp5MinID = `temp.count.${args.id}.last5Min`;
                        const actualID = `temp.count.${args.id}.day`;

                        const actual = await this.getValueAsync(actualID);

                        if (actual === null) {
                            return false;
                        }

                        const min = await this.getValueAsync(`temp.fiveMin.${args.id}.dayMin5Min`);
                        const max = await this.getValueAsync(`temp.fiveMin.${args.id}.dayMax5Min`);
                        const prevValue = await this.getValueAsync(temp5MinID);

                        // Write actual state into counter object
                        await this.setValueStatAsync(temp5MinID, actual);
                        if (prevValue === null) {
                            return false;
                        }

                        const delta = actual - prevValue;
                        this.log.debug(
                            `[STATE CHANGE] fiveMin; of : ${args.id} with min: ${min} max: ${max} actual: ${actual} prevValue: ${prevValue} delta: ${delta}`,
                        );
                        await this.setValueStatAsync(`temp.fiveMin.${args.id}.mean5Min`, delta);

                        if (min === null || delta < min) {
                            this.log.debug(`[STATE CHANGE] new Min temp.fiveMin.${args.id}.dayMin5Min: ${delta}`);
                            await this.setValueStatAsync(`temp.fiveMin.${args.id}.dayMin5Min`, delta);
                        }

                        if (max === null || delta > max) {
                            this.log.debug(`[STATE CHANGE] new Max temp.fiveMin.${args.id}.dayMax5Min: ${delta}`);
                            await this.setValueStatAsync(`temp.fiveMin.${args.id}.dayMax5Min`, delta);
                        }
                    },
                });
            }

            isStart && this.processTasks();
        }
    }

    onStateChangeAvgValue(id, value) {
        value = parseFloat(value);

        if (!isNaN(value)) {
            const isStart = !this.tasks.length;

            this.tasks.push({
                name: 'promise',
                args: {
                    id,
                    value,
                },
                callback: async args => {
                    this.log.debug(`[EXECUTING] avg call ${args.id}`);

                    if (!this.statDP[args.id]) {
                        this.log.warn(`[ABORTING] avg call ${args.id} - object no longer exists`);
                        return false;
                    }

                    this.log.debug(`[STATE CHANGE] new last for "temp.avg.${args.id}.last: ${args.value}`);

                    await this.setValueAsync(`temp.avg.${args.id}.last`, args.value);

                    for (let c = 0; c < column.length; c++) {
                        const timePeriod = column[c];

                        let avg = await this.getValueAsync(`temp.avg.${args.id}.${timePeriod}Avg`);

                        let count = await this.getValueAsync(`temp.avg.${args.id}.${timePeriod}Count`);
                        count = count ? count + 1 : 1;

                        await this.setValueAsync(`temp.avg.${args.id}.${timePeriod}Count`, count);

                        avg += (args.value - avg) / count;

                        await this.setValueAsync(`temp.avg.${args.id}.${timePeriod}Avg`, roundValue(avg, PRECISION));
                    }
                },
            });

            isStart && this.processTasks();
        }
    }

    onStateChangeTimeCntValue(id, state) {
        const isStart = !this.tasks.length;
        /*
        value with threshold or state
        Change to 1 at threshold 0 -> time between event since last 0
        Addition of time
        Change to 0 at threshold 1 -> time between event since last 1
        Addition of time
        no change but re-trigger counts up the time of respective state
        */
        if (isTrue(state.val)) {
            this.tasks.push({
                name: 'promise',
                args: {
                    id,
                    state,
                },
                callback: async args => {
                    this.log.debug(`[EXECUTING] time count ${args.id}`);

                    if (!this.statDP[args.id]) {
                        this.log.warn(`[ABORTING] time count ${args.id} - object no longer exists`);
                        return false;
                    }

                    const actual = await this.getValueAsync(`temp.timeCount.${args.id}.last`);

                    if (!isTrue(actual)) {
                        // ein echter Signalwechsel, somit Bestimmung delta für OFF-Zeitraum von 1->0 bis jetzt 0->1

                        const last = await this.getValueAsync(`temp.timeCount.${args.id}.last10`);
                        let delta = last ? args.state.ts - last : 0; // wenn last true dann delta, ansonsten 0
                        if (delta < 0) {
                            delta = 0;
                        } else {
                            delta = Math.floor(delta / 1000);
                        }

                        this.log.debug(`[STATE CHANGE] new last temp.timeCount.${args.id}.last: ${args.state.val}`);
                        await this.setValueAsync(`temp.timeCount.${args.id}.last`, args.state.val);

                        this.log.debug(
                            `[STATE CHANGE] new last01 temp.timeCount.${args.id}.last01: ${args.state.ts} ${timeConverter(args.state.ts)}`,
                        );
                        await this.setValueAsync(`temp.timeCount.${args.id}.last01`, args.state.ts);

                        this.log.debug(
                            `[STATE CHANGE] 0->1 delta ${delta} state ${timeConverter(args.state.ts)} last ${timeConverter(last)}`,
                        );

                        for (let s = 0; s < nameObjects.timeCount.temp.length; s++) {
                            // über alle Zeiträume den Wert aufaddieren
                            if (nameObjects.timeCount.temp[s].match(/off\w+$/)) {
                                const timeCountId = `temp.timeCount.${args.id}.${nameObjects.timeCount.temp[s]}`;

                                const time = await this.getValueAsync(timeCountId);
                                this.log.debug(`[STATE CHANGE] 0->1 new val ${timeCountId}: ${(time || 0) + delta}`);
                                await this.setValueAsync(timeCountId, (time || 0) + delta);
                            }
                        }
                    } else {
                        // kein Signalwechsel, nochmal gleicher Zustand, somit Bestimmung delta für update ON-Zeitraum von letzten 0->1 bis jetzt 0->1

                        const last = await this.getValueAsync(`temp.timeCount.${args.id}.last01`);
                        let delta = last ? args.state.ts - last : 0; // wenn last true dann delta, ansonsten 0
                        if (delta < 0) {
                            delta = 0;
                        } else {
                            delta = Math.floor(delta / 1000);
                        }

                        this.log.debug(`[STATE CHANGE] new last temp.timeCount.${args.id}.last: ${args.state.val}`);
                        await this.setValueAsync(`temp.timeCount.${args.id}.last`, args.state.val);

                        this.log.debug(
                            `[STATE CHANGE] new last01 temp.timeCount.${args.id}.last01: ${args.state.ts} ${timeConverter(args.state.ts)}`,
                        );
                        await this.setValueAsync(`temp.timeCount.${args.id}.last01`, args.state.ts);

                        this.log.debug(
                            `[STATE EQUAL] 1->1 delta ${delta} state ${timeConverter(args.state.ts)} last ${timeConverter(last)}`,
                        );

                        for (let s = 0; s < nameObjects.timeCount.temp.length; s++) {
                            // über alle Zeiträume den Wert aufaddieren
                            if (nameObjects.timeCount.temp[s].match(/^on\w+$/)) {
                                const timeCountId = `temp.timeCount.${args.id}.${nameObjects.timeCount.temp[s]}`;

                                const time = await this.getValueAsync(timeCountId);
                                this.log.debug(`[STATE EQUAL] 1->1 new val ${timeCountId}: ${(time || 0) + delta}`);
                                await this.setValueAsync(timeCountId, (time || 0) + delta);
                            }
                        }
                    }
                },
            });
        } else if (isFalse(state.val)) {
            this.tasks.push({
                name: 'promise',
                args: {
                    id,
                    state,
                },
                callback: async args => {
                    this.log.debug(`[EXECUTING] time count ${args.id}`);

                    if (!this.statDP[args.id]) {
                        this.log.warn(`[ABORTING] time count ${args.id} - object no longer exists`);
                        return false;
                    }

                    const actual = await this.getValueAsync(`temp.timeCount.${args.id}.last`);

                    if (isTrue(actual)) {
                        // ein echter Signalwechsel, somit Bestimmung delta für ON-Zeitraum von 0->1 bis jetzt 1->0

                        const last = await this.getValueAsync(`temp.timeCount.${args.id}.last01`);
                        let delta = last ? args.state.ts - last : 0;
                        if (delta < 0) {
                            delta = 0;
                        } else {
                            delta = Math.floor(delta / 1000);
                        }

                        this.log.debug(`[STATE CHANGE] new last temp.timeCount.${args.id}.last: ${args.state.val}`);
                        await this.setValueAsync(`temp.timeCount.${args.id}.last`, args.state.val);

                        this.log.debug(
                            `[STATE CHANGE] new last10 temp.timeCount.${args.id}.last10: ${args.state.ts} ${timeConverter(args.state.ts)}`,
                        );
                        await this.setValueAsync(`temp.timeCount.${args.id}.last10`, args.state.ts);

                        this.log.debug(
                            `[STATE CHANGE] 1->0 delta ${delta} state ${timeConverter(args.state.ts)} last ${timeConverter(last)}`,
                        );

                        for (let s = 0; s < nameObjects.timeCount.temp.length; s++) {
                            // über alle Zeiträume den Wert aufaddieren
                            if (nameObjects.timeCount.temp[s].match(/^on\w+$/)) {
                                const timeCountId = `temp.timeCount.${args.id}.${nameObjects.timeCount.temp[s]}`;

                                const time = await this.getValueAsync(timeCountId);
                                this.log.debug(`[STATE CHANGE] 1->0 new val ${timeCountId}: ${(time || 0) + delta}`);
                                await this.setValueAsync(timeCountId, (time || 0) + delta);
                            }
                        }
                    } else {
                        // kein Signalwechsel, nochmal gleicher Zustand, somit Bestimmung delta für update OFF-Zeitraum von letzten 1->0 bis jetzt 1->0

                        const last = await this.getValueAsync(`temp.timeCount.${args.id}.last10`);

                        let delta = last ? args.state.ts - last : 0;
                        if (delta < 0) {
                            delta = 0;
                        } else {
                            delta = Math.floor(delta / 1000);
                        }

                        this.log.debug(`[STATE CHANGE] new last temp.timeCount.${args.id}.last: ${args.state.val}`);
                        await this.setValueAsync(`temp.timeCount.${args.id}.last`, args.state.val);

                        this.log.debug(
                            `[STATE CHANGE] new last10 temp.timeCount.${args.id}.last10: ${args.state.ts} ${timeConverter(args.state.ts)}`,
                        );
                        await this.setValueAsync(`temp.timeCount.${args.id}.last10`, args.state.ts);

                        this.log.debug(
                            `[STATE EQUAL] 0->0 delta ${delta} state ${timeConverter(args.state.ts)} last ${timeConverter(last)}`,
                        );

                        for (let s = 0; s < nameObjects.timeCount.temp.length; s++) {
                            if (nameObjects.timeCount.temp[s].match(/off\w+$/)) {
                                const timeCountId = `temp.timeCount.${args.id}.${nameObjects.timeCount.temp[s]}`;

                                const time = await this.getValueAsync(timeCountId);
                                this.log.debug(`[STATE EQUAL] 0->0 new val ${timeCountId}: ${(time || 0) + delta}`);
                                await this.setValueAsync(timeCountId, (time || 0) + delta);
                            }
                        }
                    }
                },
            });
        }

        isStart && this.processTasks();
    }

    onStateChangeCountValue(id, value) {
        /*
            value with limit or state
            Change to 1 -> increase by 1
            Value greater threshold -> increase by 1
        */
        // nicht nur auf true/false prüfen, es muß sich um eine echte Flanke handeln
        // derzeitigen Zustand mit prüfen, sonst werden subscribed status updates mitgezählt
        const isStart = !this.tasks.length;

        this.tasks.push({
            name: 'promise',
            args: { id, value },
            callback: async args => {
                this.log.debug(`[EXECUTING] count call ${args.id}`);

                if (!this.statDP[args.id]) {
                    this.log.warn(`[ABORTING] count call ${args.id} - object no longer exists`);
                    return false;
                }

                if (await this.isTrueNew(args.id, args.value, 'count')) {
                    for (let s = 0; s < nameObjects.count.temp.length; s++) {
                        if (nameObjects.count.temp[s] !== 'lastPulse') {
                            const countId = `temp.count.${args.id}.${nameObjects.count.temp[s]}`;

                            let prevValue = await this.getValueAsync(countId);
                            prevValue = prevValue ? prevValue + 1 : 1;

                            this.log.debug(`[STATE CHANGE] Increase ${countId} on 1 to ${prevValue}`);
                            await this.setValueAsync(countId, prevValue);
                        }
                    }
                }
            },
        });

        isStart && this.processTasks();
    }

    onStateChangeSumCountValue(id, value) {
        /*
            value with limit or state
            Change to 1 -> increase by 1
            Value greater threshold -> increase by 1
        */
        // nicht nur auf true/false prüfen, es muß sich um eine echte Flanke handeln
        // derzeitigen Zustand mit prüfen, sonst werden subscribed status updates mitgezählt
        const isStart = !this.tasks.length;

        this.tasks.push({
            name: 'promise',
            args: { id, value },
            callback: async args => {
                this.log.debug(`[EXECUTING] sum count ${args.id}`);

                if (!this.statDP[args.id]) {
                    this.log.warn(`[ABORTING] sum count ${args.id} - object no longer exists`);
                    return false;
                }

                if (await this.isTrueNew(args.id, args.value, 'sumCount')) {
                    // Calculation of consumption (what is a physical-sized pulse)
                    if (
                        this.typeObjects.sumCount &&
                        this.typeObjects.sumCount.includes(args.id) &&
                        this.statDP[args.id].impUnitPerImpulse
                    ) {
                        const impUnitPerImpulse = this.statDP[args.id].impUnitPerImpulse;

                        for (let s = 0; s < nameObjects.sumCount.temp.length; s++) {
                            const sumCountId = `temp.sumCount.${args.id}.${nameObjects.sumCount.temp[s]}`;

                            const prevValue = await this.getValueAsync(sumCountId);
                            const newValue = prevValue ? prevValue + impUnitPerImpulse : impUnitPerImpulse;

                            this.log.debug(
                                `[STATE CHANGE] Increase ${sumCountId} on ${impUnitPerImpulse} to ${newValue}`,
                            );
                            await this.setValueAsync(sumCountId, newValue);
                        }

                        // add consumption to group
                        const sumGroup = this.statDP[args.id]?.sumGroup;
                        if (this.groups?.[sumGroup]?.items.includes(args.id) && this.statDP[args.id].groupFactor) {
                            const factor = this.statDP[args.id].groupFactor;
                            const price = this.groups[sumGroup].config.price;
                            const sumGroupDelta = impUnitPerImpulse * factor * price;

                            for (let g = 0; g < nameObjects.sumGroup.temp.length; g++) {
                                const sumGroupId = `temp.sumGroup.${sumGroup}.${nameObjects.sumGroup.temp[g]}`;
                                const prevValue = await this.getValueAsync(sumGroupId);

                                // Check if the value not older than interval
                                // TODO
                                /*
                                if (ts) {
                                    prevValue = this.checkValue(prevValue || 0, ts, sumGroupId, nameObjects.sumGroup.temp[i]);
                                }
                                */

                                const newValue = roundValue((prevValue || 0) + sumGroupDelta, PRECISION);
                                this.log.debug(
                                    `[STATE CHANGE] Increase ${sumGroupId} on ${sumGroupDelta} to ${newValue}`,
                                );
                                await this.setValueAsync(sumGroupId, newValue);
                            }
                        }
                    }
                }
            },
        });

        isStart && this.processTasks();
    }

    onStateChangeMinMaxValue(id, value) {
        /**
         * Comparison between last min / max and now transmitted value
         */
        value = parseFloat(value) || 0;

        if (!isNaN(value)) {
            const isStart = !this.tasks.length;

            this.tasks.push({
                name: 'promise',
                args: {
                    id,
                    value,
                },
                callback: async args => {
                    this.log.debug(`[EXECUTING] minmax ${args.id}`);

                    if (!this.statDP[args.id]) {
                        this.log.warn(`[ABORTING] minmax ${args.id} - object no longer exists`);
                        return false;
                    }

                    this.log.debug(`[STATE CHANGE] new last for "temp.minmax.${args.id}.last: ${args.value}`);
                    await this.setValueAsync(`temp.minmax.${args.id}.last`, args.value);

                    const absMin = await this.getValueAsync(`save.minmax.${args.id}.absMin`);
                    if (absMin === null || absMin > args.value) {
                        await this.setValueAsync(`save.minmax.${args.id}.absMin`, args.value);
                        this.log.debug(`[STATE CHANGE] new abs min for "${args.id}: ${args.value}`);
                    }

                    const absMax = await this.getValueAsync(`save.minmax.${args.id}.absMax`);
                    if (absMax === null || absMax < args.value) {
                        await this.setValueAsync(`save.minmax.${args.id}.absMax`, args.value);
                        this.log.debug(`[STATE CHANGE] new abs max for "${args.id}: ${args.value}`);
                    }

                    for (let c = 2; c < column.length; c++) {
                        const timePeriod = column[c];

                        const min = await this.getValueAsync(`temp.minmax.${args.id}.${timePeriod}Min`);
                        if (min === null || min > args.value) {
                            await this.setValueAsync(`temp.minmax.${args.id}.${timePeriod}Min`, args.value);
                            this.log.debug(`[STATE CHANGE] new ${timePeriod} min for "${args.id}: ${args.value}`);
                        }

                        const max = await this.getValueAsync(`temp.minmax.${args.id}.${timePeriod}Max`);
                        if (max === null || max < args.value) {
                            await this.setValueAsync(`temp.minmax.${args.id}.${timePeriod}Max`, args.value);
                            this.log.debug(`[STATE CHANGE] new ${timePeriod} max for "${args.id}: ${args.value}`);
                        }
                    }
                },
            });

            isStart && this.processTasks();
        }
    }

    onStateChangeSumDeltaValue(id, value) {
        const isStart = !this.tasks.length;
        /*
            determine the consumption per period as consecutive meter readings.
             - Validity check new value must be greater than age
             - Subtraction with last value Day
             - Subtraction with last value today -> delta for sum
             - Add delta to all values
             - treat own values differently (datapoint name)
        */
        value = parseFloat(value) || 0; // here we can probably leave the 0, if undefined then we have 0

        this.tasks.push({
            name: 'promise',
            args: {
                id,
                value,
            },
            callback: async args => {
                this.log.debug(`[EXECUTING] sum delta ${args.id}`);

                if (!this.statDP[args.id]) {
                    this.log.warn(`[ABORTING] sum delta ${args.id} - object no longer exists`);
                    return false;
                }

                const prevValue = await this.getValueAsync(`save.sumDelta.${args.id}.last`);

                await this.setValueAsync(`save.sumDelta.${args.id}.last`, args.value);

                if (prevValue === null) {
                    return false;
                }

                let delta = value - prevValue;
                if (delta < 0) {
                    if (this.statDP[args.id].sumIgnoreMinus) {
                        delta = 0;
                    }
                }
                delta = roundValue(delta, PRECISION);

                await this.setValueAsync(`save.sumDelta.${args.id}.delta`, delta);

                for (let i = 0; i < nameObjects.sumDelta.temp.length; i++) {
                    const sumDeltaId = `temp.sumDelta.${args.id}.${nameObjects.sumDelta.temp[i]}`;

                    const prevValue = await this.getValueAsync(sumDeltaId);
                    // Check if the value not older than interval
                    // TODO
                    /*
                    if (ts) {
                        prevValue = this.checkValue(prevValue, ts, sumDeltaId, nameObjects.sumDelta.temp[i]);
                    }
                    */

                    const newValue = roundValue((prevValue || 0) + delta, PRECISION);
                    this.log.debug(`[STATE CHANGE] Increase ${sumDeltaId} on ${delta} to ${newValue}`);
                    await this.setValueAsync(sumDeltaId, newValue);
                }

                // add consumption to group
                const sumGroup = this.statDP[args.id]?.sumGroup;
                if (this.groups?.[sumGroup]?.items.includes(args.id) && this.statDP[args.id].groupFactor) {
                    const factor = this.statDP[args.id].groupFactor;
                    const price = this.groups[sumGroup].config.price;
                    const sumGroupDelta = delta * factor * price;

                    for (let g = 0; g < nameObjects.sumGroup.temp.length; g++) {
                        const sumGroupId = `temp.sumGroup.${sumGroup}.${nameObjects.sumGroup.temp[g]}`;
                        const prevValue = await this.getValueAsync(sumGroupId);

                        // Check if the value not older than interval
                        // TODO
                        /*
                        if (ts) {
                            prevValue = this.checkValue(prevValue || 0, ts, sumGroupId, nameObjects.sumGroup.temp[i]);
                        }
                        */

                        const newValue = roundValue((prevValue || 0) + sumGroupDelta, PRECISION);
                        this.log.debug(`[STATE CHANGE] Increase ${sumGroupId} on ${sumGroupDelta} to ${newValue}`);
                        await this.setValueAsync(sumGroupId, newValue);
                    }
                }

                // calculate average based on delta (skipped in onStateChange)
                if (this.typeObjects.avg.includes(args.id)) {
                    this.onStateChangeAvgValue(args.id, delta);
                }
            },
        });

        isStart && this.processTasks();
    }
}

if (require.main !== module) {
    // Export the constructor in compact mode
    /**
     * @param {Partial<utils.AdapterOptions>} [options]
     */
    module.exports = options => new Statistics(options);
} else {
    // otherwise start the instance directly
    new Statistics();
}
