"use strict";
var Esq = require("esquery");
var Parse = require("esprima").parse;
var Fs = require("fs");
var Path = require("path");
var _ = require("underscore");

/*
 * TODO:
 *  - files in packages are parsed twice ??
 */

var usage =
    "Usage: node " + process.argv[1] + " [-v/--verbose] [-d/--debug] [DIR]\n" +
    "\n" +
    "    -v, --verbose    be more verbose\n" +
    "    -d, --debug      debug messages\n" +
    "    -p, --pedantic   more warnings\n" +
    "    [DIR]            directory to scan\n" +
    "\n";

var debug = false;
var verbose = false;
var reportClientServerDiscrepancy = false;
var reportRedefinitions = false;
var curDir;

var args = process.argv.slice();
args.shift();
args.shift();

args.forEach(function(arg) {
    if (arg.match(/^--?v(erbose)?/)) {
        verbose = true;
    } else if (arg.match(/^--?d(ebug)?$/)) {
        debug = true;
        verbose = true;
    } else if (arg.match(/^--?p(edantic)?$/)) {
        reportClientServerDiscrepancy = true;
        reportRedefinitions = true;
    } else if (arg.match(/^--?h(elp)?$/)) {
        process.stdout.write(usage);
        process.exit(0);
    } else if (!curDir) {
        curDir = arg;
    } else {
        process.stderr.write(usage);
        process.exit(-1);
    }

});

var predefPrototypes = {
    // Mongo.Collection functions, from docs.meteor.com
    "Mongo.Collection": {
        _ensureIndex: 3,
        allow: 1,
        deny: 1,
        insert: 2,
        find: 2,
        findOne: 2,
        rawCollection: 0,
        rawDatabase: 0,
        remove: 2,
        update: 4,
        upsert: 4,
        // https://github.com/meteorhacks/meteor-aggregate
        aggregate: 2
    }
};

var predefObjects = {
    "Presences": {
        lib: "Mongo.Collection"
    }
};

var predefs = {
    // docs.meteor.com
    "Accounts": {
        lib: {
            _storedLoginToken: 0,
            createUser: 2,
            onLogin: 1
        },
        client: {
            ui: -1
        },
        server: {
            onCreateUser: 1,
            validateNewUser: 1
        }
    },
    // https://github.com/meteor-useraccounts/core/blob/master/lib/client.js
    "AccountsTemplates": {
        client: {
            setState: 2
        },
        lib: {
            configure: 1,
            removeField: 1,
            addFields: 1
        }
    },
    // https://github.com/flowkey/bigscreen/
    "BigScreen": {
        client: {
            exit: 0,
            request: 4
        }
    },
    // docs.meteor.com
    "Blaze": {
        client: {
            getData: 1,
            getView: 2
        }
    },
    "HTTP": {
        lib: {
            call: 4,
            del: 3,
            get: 3,
            post: 3,
            put: 3
        }
    },
    // docs.meteor.com
    "Random": {
        lib: {
            fraction: 0,
            id: 1
        }
    },
    // docs.meteor.com
    "ServiceConfiguration": {
        lib: {
            configurations: -1
        }
    },
    // https://github.com/TAPevents/tap-i18n/
    "TAPi18n": {
        client: {
            getLanguage: 0,
            setLanguage: 1,
        },
        lib: {
            "__": 3,
            getLanguages: 0,
            loadTranslations: 2
        }
    },
    // https://github.com/softwarerero/meteor-accounts-t9n
    "T9n": {
        lib: {
            get: 3,
            map: 2,
            setLanguage: 1
        }
    },
    // https://github.com/percolatestudio/publish-counts
    "Counts": {
        client: {
            get: 1,
            has: 1
        },
        server: {
            publish: 4,
            noWarnings: 0
        }
    }
};

var endsJS = /\.js$/;

var libFiles = [],
    serverFiles = [],
    clientFiles = [],
    testsFiles = [];

var errorCounters = {
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

function reportError(level, id, locOrLocMessage, message) {
    errorCounters._cnt++;
    errorCounters[level]._cnt++;
    errorCounters[level][id] = (errorCounters[level][id] || 0) + 1;

    if (message) {
        process.stderr.write(locOrLocMessage + "\t" + level + ": " + message + "\n");
    } else {
        locOrLocMessage.forEach(function(lm) {
            process.stderr.write(lm[0] + "\t" + level + ": " + lm[1] + "\n");
        });
    }
}

function info(id, loc, message) {
    reportError("I", id, loc, message);
}

function warn(id, loc, message) {
    reportError("W", id, loc, message);
}

function error(id, loc, message) {
    reportError("E", id, loc, message);
}


function ignoreFile(file, filePath) {
    return file.indexOf(".") === 0 ||
        (filePath === "package.js" || filePath === "packages.json" || filePath === "README.md" || filePath === "README");
}

function tree(root, dir, accs, acc) {
    if (Fs.existsSync(dir)) {

        Fs.readdirSync(dir).forEach(function(file) {
            var p = Path.join(dir, file);
            var relP = p.substring(root.length + 1);
            var accRec = acc;
            if (!ignoreFile(file, relP)) {
                var stats = Fs.lstatSync(p);
                if (stats.isSymbolicLink(p)) {
                    if (debug) console.log("resolving symlink", p);
                    p = Fs.realpathSync(p);
                    if (debug) console.log("=>", p);
                    stats = Fs.lstatSync(p);
                    if (stats.isDirectory()) {
                        return tree(p, p, accs, acc);
                    }
                }
                if (stats.isDirectory()) {
                    switch (file) {
                        case "client":
                            accRec = acc || accs.client;
                            break;
                        case "server":
                            accRec = acc || accs.server;
                            break;
                        case "lib":
                            accRec = acc || accs.lib;
                            break;
                        case "tests":
                            accRec = acc || accs.tests;
                            break;
                        default:
                    }

                    tree(root, p, accs, accRec);

                } else if (acc) {
                    acc.push(p);
                } else if (relP.match(endsJS)) {
                    throw new Error("file not in lib, client or server: '" + relP + "'");
                }
            }
        });
    }

}


function globalsFromJSHintrc(curDir) {
    var jshintrc = Path.join(curDir, ".jshintrc");
    try {
        if (Fs.existsSync(jshintrc)) {
            if (Fs.statSync(jshintrc).isFile()) {
                console.log("jshintrc", jshintrc);
                var contents = Fs.readFileSync(jshintrc, "utf8");
                // remove single-line comments
                contents = contents.replace(new RegExp("//[^\\n]+\\n", "g"), "\n");
                var jshint = JSON.parse(contents);
                return jshint && jshint.globals;
            }
        }
    } catch (e) {
        console.log(e);
        //swallow error
    }
    var parentDir = Path.dirname(curDir);
    if (parentDir !== curDir) {
        return globalsFromJSHintrc(parentDir);
    }
}

function addAllFns(decls, loc, name, fns) {
    if (debug) console.log("addAllFns", name);
    _.each(fns, function(value, fnName) {
        var ident = name + "." + fnName;
        if (debug) console.log("  adding", ident);
        decls[ident] = {
            loc: loc,
            type: "function",
            arity: value
        };
    });
}

function getMemberFirstLevels(memberExpr) {
    if (memberExpr.type === "Identifier") {
        return memberExpr.name;
    } else {
        if (memberExpr.object.type === "MemberExpression") {
            return getMemberFirstLevels(memberExpr.object);
        } else if (memberExpr.object.type === "Identifier") {
            return memberExpr.object.name + "." + memberExpr.property.name;
        } else {
            console.error("E: unexpected identifier:", memberExpr);
            process.exit(1);
        }
    }
}

function isInterestingId(globals, member) {
    return member.type === "Identifier" && (!globals || globals[member.name]);
}

function isInterestingIdentifier(globals, memberExpr, level) {
    return isInterestingId(globals, memberExpr) ||
        (memberExpr.type === "MemberExpression" &&
            level != 1 &&
            isInterestingIdentifier(globals, memberExpr.object, level - 1));
}

function addDeclsForName(file, loc, name, value, decls) {
    var type, arity;

    if (value.type === "FunctionExpression") {
        type = "function";
        arity = value.params.length;
        if (arity === 0) {
            var usesArguments = Esq.query(value, "[type='Identifier'][name='arguments']");
            if (usesArguments.length) {
                arity = -1; // variable arguments
            }
        }
        if (debug) console.log(loc, "found decl", name + "(" + arity + ")");
    } else if (value.type === "NewExpression" && value.callee.type === "MemberExpression") {
        var typ = getMemberFirstLevels(value.callee);
        if (debug) console.log(loc, "found decl", name, "= new", typ);
        if ((typ === "Mongo.Collection") || (typ === "Meteor.Collection")) {
            addAllFns(decls, loc, name, predefPrototypes["Mongo.Collection"]);
            return;
        } else {
            if (debug) console.log("new", typ);
        }
    } else if (value.type === "ObjectExpression") {
		if (debug) console.log(loc, "found decl", nameCompo + ": Object");
        value.properties.forEach(function(prop) {
            if (prop.key.type === "Identifier") {
                var nameCompo = name + "." + prop.key.name;
                var loc = file + ":" + prop.loc.start.line;
                addDeclsForName(file, loc, nameCompo, prop.value, decls);
            } else {
                if (debug) console.log("object unsupported key", prop.key);
            }
        });
        return;
    } else {
        if (debug) console.log(loc, "found decl", name);
    }

    if (reportRedefinitions && decls[name]) {
        var other = decls[name];
        info("redef", [
            [
                loc, name + "(" + arity + ") already declared"
            ],
            [
                other.loc, name + "(" + other.arity + ") first declared there"
            ]
        ]);
    }

    decls[name] = {
        loc: loc,
        type: type,
        arity: arity
    };
}

function getDecls(file, ast, globals, decls) {
    var declsAST = Esq.query(ast, "AssignmentExpression");
    declsAST.forEach(function(p) {
        if (isInterestingIdentifier(globals, p.left, 2)) { // limit decls to 2 levels
            var name = getMemberFirstLevels(p.left);
            var loc = file + ":" + p.loc.start.line;

            addDeclsForName(file, loc, name, p.right, decls);
        }
    });
}

function getRefs(file, ast, globals, refs) {
    var refsAST = Esq.query(ast, "CallExpression");
    refsAST.forEach(function(p) {
        if (isInterestingIdentifier(globals, p.callee, 0)) { // no level limit for refs
            var name = getMemberFirstLevels(p.callee);
            var loc = file + ":" + p.loc.start.line;

            if (debug) console.log(loc, "found ref", name);

            var arity = p.arguments.length;

            refs.push({
                name: name,
                loc: loc,
                arity: arity
            });
        }
    });
}

function getDeclsRefs(file, globals, decls, refs) {
    if (verbose) console.log("reading " + file);
    var ast = Parse(Fs.readFileSync(file), parseOptions);

    getDecls(file, ast, globals, decls);
    getRefs(file, ast, globals, refs);
}


if (!curDir) {
    curDir = process.cwd();
}

process.stdout.write("Scanning " + curDir + "...\n");

var globals = globalsFromJSHintrc(curDir);

var parseOptions = {
    loc: true
};

tree(curDir, curDir, {
    lib: libFiles,
    client: clientFiles,
    server: serverFiles,
    tests: testsFiles
}, undefined);


var packages = Path.join(curDir, "packages");
if (Fs.existsSync(packages)) {
    if (verbose) console.log("reading packages", packages);
    tree(packages, packages, {
        lib: libFiles,
        client: clientFiles,
        server: serverFiles,
        tests: testsFiles
    }, undefined);
}

// FIXME: as long as duplicate files in packages
libFiles.sort();
serverFiles.sort();
clientFiles.sort();

libFiles = _.uniq(libFiles, true);
serverFiles = _.uniq(serverFiles, true);
clientFiles = _.uniq(clientFiles, true);

var libDecls = [],
    libRefs = [];
var serverDecls = [],
    serverRefs = [];
var clientDecls = [],
    clientRefs = [];


function getRefDecls(type, files, decls, refs) {

    files.forEach(function(f) {
        if (f.match(endsJS)) {
            getDeclsRefs(f, globals, decls, refs);
        }
    });
    // if(debug)console.log(type + "Decls:", decls);
    // if(debug)console.log(type + "Refs:", refs);
}

function getPackageDir(name) {
    var yname = name.match(/my:(.+)/);
    if (yname) {
        var n = yname[1];
        var packageDir = Path.resolve(curDir, "../" + n);
        if (Fs.existsSync(packageDir)) {
            return packageDir;
        } else {
            if (debug) console.log("getPackageDir couldn't find", name, "(not in", packageDir, ")");
        }
    } else {
        if (debug) console.log("getPackageDir no rule for", name);
    }
}

function treePackageJS(curDir) {
    var packageJS = Path.join(curDir, "package.js");
    if (Fs.existsSync(packageJS)) {
        if (verbose) console.log("following", packageJS);

        var ast = Parse(Fs.readFileSync(packageJS), parseOptions);
        var uses = Esq.query(ast, "CallExpression");
        uses.forEach(function(p) {
            var isApiUse = (p.callee.type === "MemberExpression") &&
                p.callee.object && (p.callee.object.name === "api") &&
                p.callee.property && (p.callee.property.name === "use") &&
                (p.arguments.length === 1 || p.arguments.length === 2);
            if (isApiUse) {
                var packages = [];
                if (p.arguments[0].type === "ArrayExpression") {
                    packages = p.arguments[0].elements.map(function(elt) {
                        return elt.value;
                    });
                }
                packages.forEach(function(name) {
                    var packageDir = getPackageDir(name);
                    if (debug) console.log("package", name, "=>", packageDir);
                    if (packageDir) {
                        tree(packageDir, packageDir, {
                            lib: libFiles,
                            client: clientFiles,
                            server: serverFiles,
                            tests: testsFiles
                        }, undefined);

                        treePackageJS(packageDir);
                    }
                });
            }
        });

    }
}

treePackageJS(curDir);

if (debug) console.log("libFiles:", libFiles);
if (debug) console.log("serverFiles:", serverFiles);


getRefDecls("lib", libFiles, libDecls, libRefs);
getRefDecls("server", serverFiles, serverDecls, serverRefs);
getRefDecls("client", clientFiles, clientDecls, clientRefs);

_.each(predefObjects, function(predefObject, predefObjectName) {
    predefs[predefObjectName] = {};
    _.each(predefObject, function(protoName, domain) {
        var proto = predefPrototypes[protoName];
        predefs[predefObjectName][domain] = {};
        _.each(proto, function(arity, funName) {
            predefs[predefObjectName][domain][funName] = arity;
        });
    });
});

_.each(predefs, function(predef, globName) {

    function addPredef(decls, predefDecls) {
        _.each(predefDecls, function(arity, name) {
            var ident = globName + "." + name;
            if (!decls[ident]) {
                decls[ident] = {
                    loc: "<<" + globName + ">>",
                    type: (arity >= 0) ? "function" : "",
                    arity: arity
                };
            }
        });
    }

    if (predef.lib) {
        addPredef(libDecls, predef.lib);
    }
    if (predef.client) {
        addPredef(clientDecls, predef.client);
    }
    if (predef.server) {
        addPredef(serverDecls, predef.server);
    }
});

_.each(serverDecls, function(decl, name) {
    var other = clientDecls[name];
    if (other) {
        if ((other.type !== decl.type) ||
            (other.arity !== decl.arity)) {
            if (reportClientServerDiscrepancy) {
                warn("client-server-discrepancy-arity", [
                    [decl.loc, name + " is " + decl.type + "(" + decl.arity + ") in server and " + other.type + "(" + other.arity + ") in client"],
                    [other.loc, name + " is " + decl.type + "(" + decl.arity + ") in server and " + other.type + "(" + other.arity + ") in client"]
                ]);
            }
        } else if (libDecls[name]) {
            if (reportClientServerDiscrepancy) {
                warn("client-server-shadows-lib", [
                    [decl.loc, name + "(" + decl.arity + ") in server and client shadows lib"],
                    [other.loc, name + "(" + decl.arity + ") in server and client shadows lib"],
                    [libDecls[name].loc, name + "(" + decl.arity + ") in server and client shadows lib"]
                ]);
            }
        }

        if (verbose) console.log(name + "(" + decl.arity + ") in server and client => putting in lib\n");
        libDecls[name] = decl;
    }
});

function checkRefs(myDomain, declsA, errorDeclsA, refs) {
    refs.forEach(function(ref) {
        var decls = _.find(declsA, function(decls) {
            return decls.hasOwnProperty(ref.name);
        });
        var decl = decls && decls[ref.name];
        if (decl) {
            if (decl.arity >= 0 && decl.arity < ref.arity) {
                error("ref-arity", ref.loc, "called " + ref.name + "(" + decl.arity + ") with " + ref.arity + " parameters");
            }
        } else {
            var found = false;
            _.each(errorDeclsA, function(decls, domain) {
                if (decls[ref.name]) {
                    error("ref-domain", ref.loc, "reference to '" + ref.name + "' defined in " + domain + " from " + myDomain);
                    found = true;
                }
            });
            if (!found) {
                error("ref-undefined", ref.loc, "reference to undefined '" + ref.name + "'");
            }
        }
    });
}

checkRefs("lib", [libDecls], {
    client: clientDecls,
    server: serverDecls
}, libRefs);
checkRefs("server", [libDecls, serverDecls], {
    client: clientDecls
}, serverRefs);
checkRefs("client", [libDecls, clientDecls], {
    server: serverDecls
}, clientRefs);


var maxLen = Math.floor(Math.log10(errorCounters._cnt || 1)) + 1;

function padRight(v) {
    var len = Math.floor(Math.log10(v || 1)) + 1;
    var res = "";
    for (var i = len; i < maxLen; i++) {
        res += " ";
    }
    return res + v;
}
process.stderr.write(" =================================================\n");
process.stderr.write(" " + padRight(errorCounters._cnt) + " messages\n");
_.each(errorCounters, function(idC, level) {
    if (level === "_cnt") return;

    process.stderr.write(" " + padRight(idC._cnt) + " " + level + "\n");
    _.each(idC, function(c, id) {
        if (id === "_cnt") return;
        process.stderr.write(" " + padRight(c) + " " + id + "\n");
    });
});