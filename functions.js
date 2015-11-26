"use strict";
var Esq = require("esquery");
var Esrecurse = require("esrecurse");
var Esprima = require("esprima");
var Eslevels = require("eslevels");
var Fs = require("fs");
var Path = require("path");
var _ = require("underscore");
var Predefs = require("./predefs.js");
var ErrorReporter = require("./error_reporter.js");

/*
 * TODO:
 *  - files in packages are parsed twice ??
 */

var usage =
    "Usage: node " + process.argv[1] + " [-v/--verbose] [-d/--debug] [-p/--pedantic] [DIR]\n" +
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
var reportThreeLevelsNotFound = false;
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
        reportThreeLevelsNotFound = true;
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


var endsJS = /\.js$/;
var endsHTML = /\.html$/;

var libFiles = [],
    serverFiles = [],
    clientFiles = [],
    testsFiles = [];

var parseOptions = {
    loc: true,
    range: true
};

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
                    try {
                        Fs.statSync(p); // will throw an error before realPathSync does (and it's not catchable)
                        p = Fs.realpathSync(p);
                        if (debug) console.log("=>", p);
                    } catch (e) {
                        ErrorReporter.error("bad-link", p, "bad symlink: " + p);
                        return;
                    }
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
                } else if (relP.match(endsJS) || relP.match(endsHTML)) {
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
            return getMemberFirstLevels(memberExpr.object) + "." + memberExpr.property.name;
        } else if (memberExpr.object.type === "Identifier") {
            return memberExpr.object.name + "." + memberExpr.property.name;
        } else if (memberExpr.object.type === "ThisExpression") {
            return "this" + "." + memberExpr.property.name;
        } else if (memberExpr.object.type === "CallExpression") {
            return "";
        } else {
            console.error("E: unexpected identifier:", memberExpr.loc.file, memberExpr);
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
            level !== 1 &&
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
    } else if (value.type === "NewExpression" &&
        (value.callee.type === "MemberExpression" || value.callee.type === "Identifier")) {
        var typ = getMemberFirstLevels(value.callee);
        if (debug) console.log(loc, "found decl", name, "= new", typ);
        if (Predefs.predefPrototypes[typ]) {
            addAllFns(decls, loc, name, Predefs.predefPrototypes[typ]);
            arity = -1;
        } else {
            if (debug) console.log("new", typ);
        }
    } else if (value.type === "ObjectExpression") {
        if (debug) console.log(loc, "found decl", name + ": Object");
        value.properties.forEach(function(prop) {
            if (prop.key.type === "Identifier") {
                var nameCompo = name + "." + prop.key.name;
                var loc = file + ":" + prop.loc.start.line;
                addDeclsForName(file, loc, nameCompo, prop.value, decls);
            } else {
                if (debug) console.log("object unsupported key", prop.key);
            }
        });
        arity = -1;
    } else {
        if (debug) console.log(loc, "found decl", name);
    }

    if (reportRedefinitions && decls[name]) {
        var other = decls[name];
        ErrorReporter.info("redef", [
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

function getDecls(file, ast, globals, type, all) {
    var decls = all[type].decls;
    var visitor = new Esrecurse.Visitor({
        AssignmentExpression: function(p) {
            if (isInterestingIdentifier(globals, p.left, 2)) { // limit decls to 2 levels
                var name = getMemberFirstLevels(p.left);
                var loc = file + ":" + p.loc.start.line;

                addDeclsForName(file, loc, name, p.right, decls);
            }
            this.visit(p.right);
        }
    });
    visitor.visit(ast);
}

function getRefs(file, ast, levels, globals, type, all) {
    var inClient = (type === "client");
    var inServer = (type === "server");
    var inLib = (type === "lib");
    var visitor = new Esrecurse.Visitor({
        CallExpression: function(p) {
            if (isInterestingIdentifier(globals, p.callee, 0)) { // no level limit for refs
                var name = getMemberFirstLevels(p.callee);
                var loc = file + ":" + p.loc.start.line;

                var lvl = levels[p.callee.range[0]];
                if (lvl === -1) {
                    if (debug) console.log(loc, "found ref", name);

                    var arity = p.arguments.length;
                    var refs;
                    if (inLib) refs = all.lib.refs;
                    else if (inServer) refs = all.server.refs;
                    else if (inClient) refs = all.client.refs;
                    else {
                        process.error(loc, "not in lib, client or server");
                        process.exit(-1);
                    }
                    refs.push({
                        name: name,
                        loc: loc,
                        arity: arity
                    });
                } else {
                    if (debug) console.log(loc, "local variable with global name:", name);
                }
            }
            this.visitChildren(p);
        },
        IfStatement: function(p) {
            var notVisited = true;
            if (p.test.type === 'MemberExpression') {
                var mem = getMemberFirstLevels(p.test);
                var testServer = (mem === "Meteor.isServer");
                var testClient = (mem === "Meteor.isClient");
                if (testClient || testServer) {
                    var loc = file + ":" + p.loc.start.line;
                    if ((inServer && testClient) ||
                        (inClient && testServer)) {
                        ErrorReporter.warn("dead-code", loc, "dead code following test for " + mem + " in " + (inClient ? "client" : "server"));
                    } else if ((inServer && testServer) ||
                        (inClient && testClient)) {
                        ErrorReporter.info("redundant-code", loc, "redundant test for " + mem + " in " + (inClient ? "client" : "server"));
                    } else if (inLib) {
                        if (debug) console.log(loc, "found test", mem);
                        inClient = testClient;
                        inServer = !inClient;
                        inLib = false;
                        this.visit(p.consequent);
                        inClient = !inClient;
                        inServer = !inClient;
                        this.visit(p.alternate);
                        inLib = true;
                        inClient = inServer = false;
                        notVisited = false;
                    }
                }
            }
            if (notVisited) this.visitChildren(p);
        }
    });
    visitor.visit(ast);
}

function getDeclsRefs(file, type, all, globals) {
    if (verbose) console.log("reading " + file);
    var ast = Esprima.parse(Fs.readFileSync(file), parseOptions);
    var levels = Eslevels.levels(ast, {
        mode: "mini"
    });

    var levelsDict = {};
    levels.forEach(function(l) {
        levelsDict[l[1]] = l[0];
    });

    getDecls(file, ast, globals, type, all);
    getRefs(file, ast, levelsDict, globals, type, all);
}


if (!curDir) {
    curDir = process.cwd();
}

process.stdout.write("Scanning " + curDir + "...\n");

var globals = globalsFromJSHintrc(curDir);

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


function getRefDecls(all) {
    _.each(all, function(content, type) {
        content.files.forEach(function(f) {
            if (f.match(endsJS)) {
                getDeclsRefs(f, type, all, globals);
            }
        });
        // if(debug)console.log(type + "Decls:", decls);
        // if(debug)console.log(type + "Refs:", refs);
    });
}

function getDeclsTemplatesOne(f, decls) {
    if (debug) console.log("reading", f);
    var contents = Fs.readFileSync(f, "utf-8");
    var templateExtractor = /<template name="([^"]+)"/g;
    var lineNum = 1;

    var result;
    while (result = templateExtractor.exec(contents)) {
        var loc = f + ":" + lineNum;
        var name = "Template." + result[1];
        if (debug) console.log(loc, "found", name);
        addAllFns(decls, loc, name, Predefs.predefPrototypes.Template);
    }
}

function getDeclsTemplates(files, decls) {

    files.forEach(function(f) {
        if (f.match(endsHTML)) {
            getDeclsTemplatesOne(f, decls);
        }
    });
}

function getPackageDir(name) {
    var yname = name.match(/y:(.+)/);
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

        var ast = Esprima.parse(Fs.readFileSync(packageJS), parseOptions);
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

Predefs.getPredefs({
    lib: libDecls,
    server: serverDecls,
    client: clientDecls
});


getRefDecls({
    lib: {
        files: libFiles,
        decls: libDecls,
        refs: libRefs
    },
    server: {
        files: serverFiles,
        decls: serverDecls,
        refs: serverRefs
    },
    client: {
        files: clientFiles,
        decls: clientDecls,
        refs: clientRefs
    }
});

getDeclsTemplates(clientFiles, clientDecls);


_.each(serverDecls, function(decl, name) {
    var other = clientDecls[name];
    if (other) {
        if ((other.type !== decl.type) ||
            (other.arity !== decl.arity)) {
            if (reportClientServerDiscrepancy) {
                ErrorReporter.warn("client-server-discrepancy-arity", [
                    [decl.loc, name + " is " + decl.type + "(" + decl.arity + ") in server and " + other.type + "(" + other.arity + ") in client"],
                    [other.loc, name + " is " + decl.type + "(" + decl.arity + ") in server and " + other.type + "(" + other.arity + ") in client"]
                ]);
            }
        } else if (libDecls[name]) {
            if (reportClientServerDiscrepancy) {
                ErrorReporter.warn("client-server-shadows-lib", [
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

var threeLevelsRE = /^\w+\.\w+\.\w+/;

function checkRef(myDomain, declsA, errorDeclsA, ref, quietNotFound) {
    var decls = _.find(declsA, function(decls) {
        return decls.hasOwnProperty(ref.name);
    });
    var decl = decls && decls[ref.name];
    var found = Boolean(decl);
    if (found) {
        if (decl.arity >= 0 && decl.arity < ref.arity) {
            ErrorReporter.error("ref-arity", ref.loc, "called " + ref.name + "(" + decl.arity + ") with " + ref.arity + " parameters");
        }
    } else {
        _.each(errorDeclsA, function(decls, domain) {
            if (decls[ref.name]) {
                ErrorReporter.error("ref-domain", ref.loc, "reference to '" + ref.name + "' defined in " + domain + " from " + myDomain);
                found = true;
            }
        });
        if (!found) {
            var lastDot = ref.name.lastIndexOf(".");
            if (lastDot > 0) {
                var newRef = _.clone(ref);
                newRef.name = ref.name.substring(0, lastDot);
                found = checkRef(myDomain, declsA, errorDeclsA, newRef, true);
                if (found) {
                    if (threeLevelsRE.test(ref.name)) {
                        if (reportThreeLevelsNotFound) ErrorReporter.info("ref-incomplete-3", ref.loc, "not found " + ref.name + " but " + newRef.name);
                    } else {
                        ErrorReporter.warn("ref-incomplete", ref.loc, "not found " + ref.name + " but " + newRef.name);
                    }
                }
            }
            if (!found && !quietNotFound) {
                ErrorReporter.error("ref-undefined", ref.loc, "reference to undefined '" + ref.name + "'");
            }
        }
    }
    return found;
}

function checkRefs(myDomain, declsA, errorDeclsA, refs) {
    refs.forEach(function(ref) {
        checkRef(myDomain, declsA, errorDeclsA, ref, false);
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


var maxLen = Math.floor(Math.log10(ErrorReporter.errorCounters._cnt || 1)) + 1;

function padRight(v) {
    var len = Math.floor(Math.log10(v || 1)) + 1;
    var res = "";
    for (var i = len; i < maxLen; i++) {
        res += " ";
    }
    return res + v;
}
process.stderr.write(" =================================================\n");
process.stderr.write(" " + padRight(ErrorReporter.errorCounters._cnt) + " messages\n");
_.each(ErrorReporter.errorCounters, function(idC, level) {
    if (level === "_cnt") return;

    process.stderr.write(" " + padRight(idC._cnt) + " " + level + "\n");
    _.each(idC, function(c, id) {
        if (id === "_cnt") return;
        process.stderr.write(" " + padRight(c) + " " + id + "\n");
    });
})
