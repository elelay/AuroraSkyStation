"use strict";
var Esq = require("esquery");
var Esrecurse = require("esrecurse");
var Esprima = require("esprima");
var Eslevels = require("eslevels");
var Fs = require("fs");
var Path = require("path");
var Util = require("util");
var _ = require("underscore");
var Predefs = require("./predefs.js");
var ErrorReporter = require("./error_reporter.js");
var FindFiles = require("./find_files.js");

/*
 * TODO:
 *  - files in packages are parsed twice ??
 */

function usage(args, exitCode) {

    var u = "Usage: " + args[0] + " " + args[1] + " [-v/--verbose] [-d/--debug] [-p/--pedantic] [-t/--this-only] [DIR]\n" +
        "\n" +
        "    -v, --verbose    be more verbose\n" +
        "    -d, --debug      debug messages\n" +
        "    -p, --pedantic   more warnings\n" +
        "    -t, --this-code  don't show errors in dependencies\n" +
        "    [DIR]            directory to scan\n" +
        "\n";
    if (exitCode) {
        process.stderr.write(u);
    } else {
        process.stdout.write(u);
    }
    process.exit(exitCode);
}

var debug = false;
var verbose = false;
var reportClientServerDiscrepancy = false;
var reportRedefinitions = false;
var reportThreeLevelsNotFound = false;
var thisCodeOnly = false;
var curDir;

var parseOptions = {
    loc: true,
    range: true
};

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
                arity = -2; // variable arguments
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
    } else if (value.type === "Literal") {
        if (debug) console.log(loc, "found decl", name + ": Literal");
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

function isWhereServer(p) {
    return (p.type === "ObjectExpression") &&
        _.some(p.properties, function(prop) {
            return (prop.key.type === "Identifier" && prop.key.name === "where") &&
                (prop.value.type === "Literal" && prop.value.value === "server");
        });
}

function testIsClientServer(pTest) {
    if (pTest.type === "MemberExpression") {
        var test = {
            not: false
        };
        test.mem = getMemberFirstLevels(pTest);
        test.server = (test.mem === "Meteor.isServer");
        test.client = (test.mem === "Meteor.isClient") || (test.mem === "this.isSimulation");
    } else {
        var test = testIsClientServer(pTest.argument);
        test.not = true;
        test.mem = "!" + test.mem;
    }
    return test;
}

function getRefs(file, ast, levels, globals, type, all) {
    var inClient = (type === "client");
    var inServer = (type === "server");
    var inLib = (type === "lib");



    function DerivedVisitor(options) {
        Esrecurse.Visitor.call(this, options);
    }
    Util.inherits(DerivedVisitor, Esrecurse.Visitor);
    DerivedVisitor.prototype.ifOrConditionalExpression = function(p) {
        var notVisited = true;
        if ((p.test.type === "MemberExpression") ||
            (p.test.type === "UnaryExpression" && p.test.operator === "!" &&
                p.test.argument.type === "MemberExpression")) {
            var test = testIsClientServer(p.test);
            if (test.client || test.server) {

                var testServer = test.not ? !test.server : test.server;
                var testClient = test.not ? !test.client : test.client;

                var loc = file + ":" + p.loc.start.line;
                if ((inServer && testClient) ||
                    (inClient && testServer)) {
                    ErrorReporter.warn("dead-code", loc, "dead code following test for " + test.mem + " in " + (inClient ? "client" : "server"));
                } else if ((inServer && testServer) ||
                    (inClient && testClient)) {
                    ErrorReporter.info("redundant-code", loc, "redundant test for " + test.mem + " in " + (inClient ? "client" : "server"));
                } else if (inLib) {
                    if (debug) console.log(loc, "found test", test.mem);
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
            } else {
                this.tryMemberExpression(p.test, -1);
            }
        }
        if (notVisited) this.visitChildren(p);
    };

    DerivedVisitor.prototype.tryMemberExpression = function(p, arity) {
        if (isInterestingIdentifier(globals, p, 0)) { // no level limit for refs
            var name = getMemberFirstLevels(p);
            var loc = file + ":" + p.loc.start.line;

            var lvl = levels[p.range[0]];
            if (lvl === -1) {
                if (debug) console.log(loc, "found ref", name, arity);

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
    };

    var visitor = new DerivedVisitor({
        CallExpression: function(p) {
            var arity = p.arguments.length;
            var notVisited = true;
            if (inLib && isInterestingIdentifier(globals, p.callee, 0)) {
                var name = getMemberFirstLevels(p.callee);
                var isRoute = name === "Router.route";
                var isController = name === "RouteController.extend";
                var isAccountsConfigure = name === "AccountsTemplates.configure";
                if (isRoute || isController || isAccountsConfigure) {
                    var loc = file + ":" + p.loc.start.line;
                    var onServer = (p.arguments.length === 3 && isWhereServer(p.arguments[2]));
                    var onClient = (isRoute &&
                            p.arguments.length === 2 &&
                            p.arguments[1].type === "ObjectExpression") ||
                        (isRoute && !onServer) || isController || isAccountsConfigure;

                    if (onClient || onServer) {
                        if (debug) console.log(loc, "found", onClient ? "client" : "server", "route");
                        inClient = onClient;
                        inServer = !inClient;
                        inLib = false;
                        p.arguments.forEach(function(arg) {
                            this.visit(arg);
                        }, this);
                        inLib = true;
                        inClient = inServer = false;
                        notVisited = false;
                    }
                }
            }
            if (notVisited) {
                this.tryMemberExpression(p.callee, arity);
                this.visitChildren(p);
            }
        },
        IfStatement: function(p) {
            this.ifOrConditionalExpression(p);
        },
        ConditionalExpression: function(p) {
            this.ifOrConditionalExpression(p);
        },
        ExpressionStatement: function(p) {
            if (p.expression.type === "MemberExpression") {
                this.tryMemberExpression(p.expression, -1);
            } else {
                this.visitChildren(p);
            }
        }
    });
    visitor.visit(ast);
}

var useAuroreRE = /^\s*use\s+aurore::([^ ]+)\s+false\s*$/;

function getDeclsRefsOneFile(file, type, all, globals) {
    if (verbose) console.log("reading " + file);
    var ast = Esprima.parse(Fs.readFileSync(file), parseOptions);
    var levels = Eslevels.levels(ast, {
        mode: "mini"
    });

    var levelsDict = {};
    levels.forEach(function(l) {
        levelsDict[l[1]] = l[0];
    });

    var topLiterals = Esq.query(ast, "Program > ExpressionStatement > Literal");
    topLiterals.forEach(function(l) {
        var res = useAuroreRE.exec(l.value);
        if (res) {
            var ident = res[1];
            if (verbose) console.log("disabling", ident, "for", file);
            if (!ErrorReporter.disable[file]) {
                ErrorReporter.disable[file] = {};
            }
            ErrorReporter.disable[file][ident] = true;
        }
    });

    getDecls(file, ast, globals, type, all);
    getRefs(file, ast, levelsDict, globals, type, all);
}




var endsJS = /\.js$/;
var endsHTML = /\.html$/;

function getDeclsRefs(all, globals) {
    _.each(all, function(content, type) {
        content.files.forEach(function(f) {
            if (f.match(endsJS)) {
                getDeclsRefsOneFile(f, type, all, globals);
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
    while ((result = templateExtractor.exec(contents))) {
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
        } else if (decl.arity == -1 && ref.arity >= 0 && !quietNotFound) {
            ErrorReporter.error("ref-arity", ref.loc, "called non function " + ref.name + " with " + ref.arity + " parameters");
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

function report() {
    var labels = {
        "I": "information",
        "W": "warning",
        "E": "error"
    };
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

        process.stderr.write(" " + padRight(idC._cnt) + " " + labels[level] + "\n");
        _.each(idC, function(c, id) {
            if (id === "_cnt") return;
            process.stderr.write(new Array(maxLen + 1).join(" ") + "  " + padRight(c) + " " + id + "\n");
        });
    });
    process.stderr.write(" =================================================\n");
    process.stderr.write(JSON.stringify(ErrorReporter.errorCounters) + "\n");
}

function interpret(argv) {
    var args = argv.slice();
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
        } else if (arg.match(/^--?t(his-code)?$/)) {
            thisCodeOnly = true;
        } else if (arg.match(/^--?h(elp)?$/)) {
            return usage(argv, 0);
        } else if (!curDir) {
            curDir = arg;
        } else {
            return usage(argv, -1);
        }

    });


    if (!curDir) {
        curDir = process.cwd();
    }

    ErrorReporter.debug = debug;
    ErrorReporter.curDir = curDir;
    ErrorReporter.thisCodeOnly = thisCodeOnly;

    FindFiles.debug = debug;
    FindFiles.verbose = verbose;
    FindFiles.ErrorReporter = ErrorReporter;

    process.stdout.write("Scanning " + curDir + "...\n");

    var globals = FindFiles.globalsFromJSHintrc(curDir);

    var libFiles = [],
        serverFiles = [],
        clientFiles = [],
        testsFiles = [];

    var filesObj = {
        lib: libFiles,
        client: clientFiles,
        server: serverFiles,
        tests: testsFiles
    };

    var libDecls = [],
        libRefs = [];
    var serverDecls = [],
        serverRefs = [];
    var clientDecls = [],
        clientRefs = [];



    FindFiles.tree(curDir, curDir, filesObj, undefined);


    var packages = Path.join(curDir, "packages");
    if (Fs.existsSync(packages)) {
        if (verbose) console.log("reading packages", packages);
        FindFiles.tree(packages, packages, {
            lib: libFiles,
            client: clientFiles,
            server: serverFiles,
            tests: testsFiles
        }, undefined);
    }

    FindFiles.treePackageJS(curDir, curDir, filesObj);


    // FIXME: as long as duplicate files in packages
    libFiles.sort();
    serverFiles.sort();
    clientFiles.sort();

    libFiles = _.uniq(libFiles, true);
    serverFiles = _.uniq(serverFiles, true);
    clientFiles = _.uniq(clientFiles, true);

    if (debug) console.log("libFiles:", libFiles);
    if (debug) console.log("serverFiles:", serverFiles);

    Predefs.getPredefs({
        lib: libDecls,
        server: serverDecls,
        client: clientDecls
    });


    getDeclsRefs({
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
    }, globals);

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

    report();
    return 0;
}

exports.interpret = interpret;
