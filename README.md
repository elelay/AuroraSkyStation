# Aurore - a meteor project checker

Install with `npm install -g`.

## Pubsub

    node pubsub.js PROJECT_DIRECTORY

Checks that subscriptions match publications (catch typos).

outputs errors on stderr

Todo: check arity

## Call (todo)

Checks that methods called actually exist.


## Functions

	aurore [-v/--verbose] [-d/--debug] [-p/--pedantic] [-t/--this-only] [PROJECT_DIRECTORY]

Checks that
 - global references actually exist and if functions, they are not given
   more parameters than they can handle.
 - references are in visible scopes (lib, server, client)
 - globals are not redefined (with the -p option)


Needs a whitelist of predefined objects and functions (see `src/predefs.js`).

If a `packages` directory exists, its subdirectories (or symlinks) will be scanned.

If a `package.js` file exists, it will be read and packages listed in `api.use` will be analyzed recursively.
`functions.js` looks for packages in parent directory and uses a custom name mapping,
so you may have to modify `src/find_files.js#getPackageDir(packageName)` for your project.

All files are gathered before checking decls/refs, so it's better to run `functions.js`
for every package, to be sure that it only depends on packages it uses.

### Messages

#### Information

 - *redef*
   Redefinitions may be legitimate (different definitions, in an if/else),
   so redefinitions are only Information level messages.

 - *redundant-code*
   When using `Meteor.isServer` and `Meteor.isClient` respectively  in a server and client context.

#### Warning

 - *dead-code*
   For code in an `if(Meteor.isServer)` and `if(Meteor.isClient)` respectively  in a client and server context.

 - *ref-incomplete*

 - *client-server-discrepancy-arity*

 - *client-server-shadows-lib*

#### Error

 - *bad-link*
 Could not follow a symlink.

 - *ref-arity*

 - *ref-domain*

 - *ref-undefined*

## License

Aurore is provided under the [AGPL-3.0](https://www.gnu.org/licenses/agpl-3.0.html).

As a (hopefully) temporary workaround, it includes a [modified version of eslevels](https://github.com/elelay/eslevels/blob/f243e15d3c4031c66ff3a27ed51f9a075bad1f63/eslevels.js),
copyright 2013 Alexander (Sacha) Mazurov, under the BSD license).