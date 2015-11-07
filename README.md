# Aurore - a meteor project checker

Install with `npm install`.

## Pubsub

    node pubsub.js PROJECT_DIRECTORY

Checks that subscriptions match publications (catch typos).

outputs errors on stderr

Todo: check arity

## Call (todo)

Checks that methods called actually exist.


## Functions

	node functions.js [-v/--verbose] [-d/--debug] [-p/--pedantic] [PROJECT_DIRECTORY]

Checks that
 - global references actually exist and if functions, they are not given
   more parameters than they can handle.
 - references are in visible scopes (lib, server, client)
 - globals are not redefined (with the -p option)


Needs a whitelist of predefined objects and functions.

If a `packages` directory exists, its subdirectories (or symlinks) will be scanned.

If a `package.js` file exists, it will be read packages listed in `api.use` will be analyzed recursively.
`functions.js` looks for packages in parent directory and uses a custom name mapping,
so you may have to modify `getPackageDir(packageName)` for your project.

All files are gathered before checking decls/refs, so it's better to run `functions.js`
for every package, to be sure that it only depends on packages it uses.

Redefinitions may be legitimate (different definitions, in an if/else),
so redefinitions are only Information level messages.
