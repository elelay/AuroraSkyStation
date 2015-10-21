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
    "    [DIR]            directory to scan\n" +
    "\n";

var debug = false;
var verbose = false;
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
    } else if (!curDir) {
        curDir = arg;
    } else if (arg.match(/^--?h(elp)?$/)) {
        process.stdout.write(usage);
        process.exit(0);
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
        upsert: 4
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
            getView: 1
        }
    },
    "HTTP": {
        lib: {
            call: 4
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
    }
};

var endsJS = /\.js$/;

var libFiles = [],
    serverFiles = [],
    clientFiles = [],
    testsFiles = [];

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

function isInterestingIdentifier(globals, memberExpr) {
    return isInterestingId(globals, memberExpr) || (memberExpr.type === "MemberExpression" && isInterestingIdentifier(globals, memberExpr.object));
}

function getDeclsRefs(file, globals, decls, refs) {
    if (verbose) console.log("reading " + file);
    var ast = Parse(Fs.readFileSync(file), parseOptions);
    var declsAST = Esq.query(ast, "AssignmentExpression");
    declsAST.forEach(function(p) {
        if (isInterestingIdentifier(globals, p.left)) {
            var name = getMemberFirstLevels(p.left);
            var loc = file + ":" + p.loc.start.line;

            var type, arity;
            if (p.right.type === "FunctionExpression") {
                type = "function";
                arity = p.right.params.length;
                if (arity === 0) {
                    var usesArguments = Esq.query(p.right, "[type='Identifier'][name='arguments']");
                    if (usesArguments) {
                        arity = -1; // variable arguments
                    }
                }
                if (debug) console.log(loc, "found decl", name + "(" + arity + ")");
            } else if (p.right.type === "NewExpression" && p.right.callee.type === "MemberExpression") {
                var typ = getMemberFirstLevels(p.right.callee);
                if (debug) console.log(loc, "found decl", name, "= new", typ);
                if ((typ === "Mongo.Collection") || (typ === "Meteor.Collection")) {
                    addAllFns(decls, loc, name, predefPrototypes["Mongo.Collection"]);
                } else {
                    if (debug) console.log("new", typ);
                }
            } else {
                if (debug) console.log(loc, "found decl", name);
            }

            decls[name] = {
                loc: loc,
                type: type,
                arity: arity
            };
        }
    });

    var refsAST = Esq.query(ast, "CallExpression");
    refsAST.forEach(function(p) {
        if (isInterestingIdentifier(globals, p.callee)) {
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


if (!curDir) {
    curDir = process.cwd();
}

process.stdout.write("Scanning " + curDir + "...\n");

var globals = globalsFromJSHintrc(curDir);

// FIXME: extract functions list in
delete globals["BrowserPolicy"];
delete globals["DDP"];
delete globals["Meteor"];
delete globals["Cluster"];
delete globals["Tracker"];
delete globals["Npm"];
delete globals["_"];
delete globals["Fs"];
delete globals["Logger"];
delete globals["Router"];
delete globals["Session"];
delete globals["Template"];
delete globals["UI"];

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

if (debug) console.log("libFiles:", libFiles);
if (debug) console.log("serverFiles:", serverFiles);


function getRefDecls(type, files, decls, refs) {

    files.forEach(function(f) {
        if (f.match(endsJS)) {
            getDeclsRefs(f, globals, decls, refs);
        }
    });
    // if(debug)console.log(type + "Decls:", decls);
    // if(debug)console.log(type + "Refs:", refs);
}


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
                process.stderr.write(decl.loc + "\t" + name + " is " + decl.type + "(" + decl.arity + ") in server and " + other.type + "(" + other.arity + ") in client\n");
                process.stderr.write(other.loc + "\t" + name + " is " + decl.type + "(" + decl.arity + ") in server and " + other.type + "(" + other.arity + ") in client\n");
            }
        } else if (libDecls[name]) {
            if (reportClientServerDiscrepancy) {
                process.stderr.write(decl.loc + "\t" + name + "(" + decl.arity + ") in server and client shadows lib\n");
                process.stderr.write(other.loc + "\t" + name + "(" + decl.arity + ") in server and client shadows lib\n");
                process.stderr.write(libDecls[name].loc + "\t" + name + "(" + decl.arity + ") in server and client shadows lib\n");
            }
        } else {
            if (verbose) console.log(name + "(" + decl.arity + ") in server and client => putting in lib\n");
            libDecls[name] = decl;
        }
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
                process.stderr.write(ref.loc + "\tcalled " + ref.name + "(" + decl.arity + ") with " + ref.arity + " parameters\n");
            }
        } else {
            var found = false;
            _.each(errorDeclsA, function(decls, domain) {
                if (decls[ref.name]) {
                    process.stderr.write(ref.loc + "\treference to '" + ref.name + "' defined in " + domain + " from " + myDomain + "\n");
                    found = true;
                }
            });
            if (!found) {
                process.stderr.write(ref.loc + "\treference to undefined '" + ref.name + "'\n");
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