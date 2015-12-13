var _ = require("underscore");

exports.errorCounters = {
    "I": {
        _cnt: 0
    },
    "W": {
        _cnt: 0
    },
    "E": {
        _cnt: 0
    },
    _cnt: 0
};

exports.thisCodeOnly = false;

exports.curDir = null;

exports.debug = false;

function excludeThisCodeOnly(locOrMessage, message) {
    if (message) {
        return !locOrMessage.startsWith(exports.curDir);
    } else {
        return _.every(locOrLocMessage, function(lm) {
            return excludeThisCodeOnly(lm[0]);
        });
    }
}

function reportError(level, id, locOrLocMessage, message) {

    if (exports.thisCodeOnly && excludeThisCodeOnly(locOrLocMessage, message)) {
        if (exports.debug) console.log("D: silent error", level, id, locOrLocMessage, message);
        return;
    }

    exports.errorCounters._cnt++;
    exports.errorCounters[level]._cnt++;
    exports.errorCounters[level][id] = (exports.errorCounters[level][id] || 0) + 1;

    if (message) {
        process.stderr.write(locOrLocMessage + "\t" + level + ": " + message + "\n");
    } else {
        locOrLocMessage.forEach(function(lm) {
            process.stderr.write(lm[0] + "\t" + level + ": " + lm[1] + "\n");
        });
    }
}

exports.info = function(id, loc, message) {
    reportError("I", id, loc, message);
};

exports.warn = function(id, loc, message) {
    reportError("W", id, loc, message);
};

exports.error = function(id, loc, message) {
    reportError("E", id, loc, message);
};
