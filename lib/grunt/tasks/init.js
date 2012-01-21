/*
 * grunt
 * https://github.com/cowboy/grunt
 *
 * Copyright (c) 2012 "Cowboy" Ben Alman
 * Licensed under the MIT license.
 * http://benalman.com/about/license/
 */

var fs = require('fs');
var path = require('path');

var async = require('async');
var spawn = require('child_process').spawn;
var semver = require('semver');

var prompt = require('prompt');
prompt.message = '[' + '?'.green + ']';
prompt.delimiter = ' ';

// ============================================================================
// TASKS
// ============================================================================

task.registerInitTask('init', 'Initialize a project from a predefined template.', function(name) {
  // Path to init's extra files.
  var extras = file.extraspath('init');
  // Array of valid template names (.js files in the extras path).
  var templates = fs.readdirSync(extras).filter(function(filename) {
    return fs.statSync(path.join(extras, filename)).isFile() &&
      path.extname(filename) === '.js';
  }).map(function(filename) {
    return path.basename(filename, '.js');
  });

  // Abort if a valid template was not specified.
  if (!name || templates.indexOf(name) === -1) {
    fail.warn('A valid template name must be specified. Valid templates are "' +
      templates.join('", "') + '".');
  }

  // Abort if a gruntfile was found (to avoid accidentally nuking it).
  if (path.existsSync(path.join(process.cwd(), 'grunt.js'))) {
    fail.warn('Beware, grunt.js file already exists.');
  }

  // This task is asynchronous.
  var taskDone = this.async();

  // Useful init sub-task-specific utilities.
  var init = {
    // Any user-specified default init values.
    defaults: initDefaults(),
    // Determine absolute source file path.
    srcpath: path.join.bind(path, extras, name),
    // Determine absolute destination file path.
    destpath: path.join.bind(path, process.cwd()),
    // Given some number of licenses, add properly-named license files to the
    // files array.
    addLicenseFiles: function(files, licenses) {
      var available = availableLicenses();
      licenses.forEach(function(license) {
        files.push({
          src: available.indexOf(license) === -1 ? '../misc/placeholder' :
            '../licenses/LICENSE-' + license,
          dest: 'LICENSE-' + license
        });
      });
    },
    // Given a relative URL, copy a file (optionally processing it through
    // a passed callback).
    copy: function(srcpath, destpath, callback) {
      if (typeof destpath !== 'string') {
        callback = destpath;
        destpath = srcpath;
      }
      var abssrcpath = init.srcpath(srcpath);
      var absdestpath = init.destpath(destpath);
      verbose.or.write('Writing ' + destpath + '...');
      try {
        file.copy(abssrcpath, absdestpath, callback);
        verbose.or.ok();
      } catch(e) {
        verbose.or.error();
        throw e;
      }
    },
    // Iterate over all files in the passed array, copying the source file to
    // the destination, processing the contents.
    copyAndProcess: function(files, props) {
      files.forEach(function(files) {
        init.copy(files.src, files.dest || files.src, function(contents) {
          return underscore.template(contents)(props);
        });
      });
    },
    // Save a package.json file in the destination directory..
    writePackage: function(filename, props, callback) {
      var pkg = {};
      // Basic values.
      ['name', 'description', 'version', 'homepage'].forEach(function(prop) {
        if (prop in props) { pkg[prop] = props[prop]; }
      });
      // Author.
      if ('author_name' in props) {
        pkg.author = props.author_name;
        if (props.author_email) { pkg.author += ' <' + props.author_email + '>'; }
        if (props.author_url) { pkg.author += ' (' + props.author_url + ')'; }
      }
      // Other stuff.
      if ('repository' in props) { pkg.repository = {type: 'git', url: props.repository}; }
      if ('bugs' in props) { pkg.bugs = {url: props.bugs}; }
      pkg.licenses = props.licenses.map(function(license) {
        return {type: license, url: props.homepage + '/blob/master/LICENSE-' + license};
      });
      pkg.dependencies = {};
      pkg.devDependencies = {};
      pkg.keywords = [];

      // Node/npm-specific:
      if (props.node_version) { pkg.engines = {node: props.node_version}; }
      if (props.node_main) { pkg.main = props.node_main; }
      if (props.node_test) {
        pkg.scripts = {test: props.node_test};
        if (props.node_test.split(' ')[0] === 'grunt') {
          pkg.devDependencies.grunt = '~' + grunt.version;
        }
      }

      // Allow final tweaks to the pkg object.
      if (callback) { pkg = callback(pkg, props); }

      // Write file.
      file.write(init.destpath(filename), JSON.stringify(pkg, null, 2));
    }
  };

  // Execute template code.
  require(path.join(extras, name))(init, function() {
    // Fail task if errors were logged.
    if (task.hadErrors()) { taskDone(false); }
    // Otherwise, print a success message.
    log.writeln().writeln('Initialized from template "' + name + '".');
    // All done!
    taskDone();
  });
});

// ============================================================================
// HELPERS
// ============================================================================

// Prompt user to override default values passed in obj.
task.registerHelper('prompt', function(properties, done) {
  var defaults = initDefaults();

  var sanitize = {};
  properties.forEach(function(property) {
    if (property.sanitize) {
      sanitize[property.name] = property.sanitize;
    }
  });

  properties.push({
    message: 'Are these answers correct?'.green,
    name: 'ANSWERS_VALID',
    default: 'Y/n'
  });

  (function ask() {
    log.subhead('Please answer the following:');
    var result = {};
    async.forEachSeries(properties, function(property, done) {
      function doPrompt() {
        prompt.start();
        prompt.getInput(property, function(err, line) {
          if (err) { return done(err); }
          result[property.name] = line;
          done();
        });
      }
      if (property.name in defaults) {
        property.default = defaults[property.name];
      }
      if (typeof property.default === 'function') {
        property.default(result, function(err, value) {
          property.default = err ? '???' : value;
          doPrompt();
        });
      } else {
        doPrompt();
      }
    }, function(err) {
      if (/y/i.test(result.ANSWERS_VALID)) {
        prompt.pause();
        delete result.ANSWERS_VALID;
        Object.keys(result).forEach(function(key) {
          if (sanitize[key]) { result[key] = sanitize[key](result[key], result); }
          if (result[key] === 'none') { result[key] = ''; }
        });
        log.writeln();
        done(err, result);
      } else {
        properties.slice(0, -1).forEach(function(property) {
          property.default = result[property.name];
        });
        ask();
      }
    });


    // async.map(properties, function(property, done) {
    //   if (property.name in defaults) {
    //     property.default = defaults[property.name];
    //   }
    //   if (typeof property.default === 'function') {
    //     property.default(function(err, value) {
    //       property.default = err ? '???' : value;
    //       done(null, property);
    //     });
    //   } else {
    //     done(null, property);
    //   }
    // }, function(err, result) {
    //   log.subhead('Please answer the following:');
    //   prompt.start();
    //   prompt.get(result, function(err, result) {
    //     if (/y/i.test(result.ANSWERS_VALID)) {
    //       prompt.pause();
    //       delete result.ANSWERS_VALID;
    //       Object.keys(result).forEach(function(key) {
    //         if (sanitize[key]) { result[key] = sanitize[key](result[key], result); }
    //         if (result[key] === 'none') { result[key] = ''; }
    //       });
    //       log.writeln();
    //       done(err, result);
    //     } else {
    //       properties.slice(0, -1).forEach(function(property) {
    //         property.default = result[property.name];
    //       });
    //       ask();
    //     }
    //   });
    // });
  }());
});

// Spawn a child process, capturing its stdout and stderr.
task.registerHelper('child_process', function(opts, done) {
  var child = spawn(opts.cmd, opts.args, opts.opts);
  var results = [];
  var errors = [];
  child.stdout.on('data', results.push.bind(results));
  child.stderr.on('data', errors.push.bind(errors));
  child.on('exit', function(code) {
    if (code === 0) {
      done(null, results.join('').replace(/\s+$/, ''));
    } else if ('fallback' in opts) {
      done(null, opts.fallback);
    } else {
      done(errors.join('').replace(/\s+$/, ''));
    }
  });
});

// Useful properties with default values.
task.registerHelper('property', function(name, alternateDefault) {
  var properties = {
    name: {
      message: 'Project name',
      default: path.basename(process.cwd()),
      validator: /^[\w\-]+$/,
      warning: 'Name must be only letters, numbers, dashes or underscores.',
      sanitize: function(value, obj) {
        obj.js_safe_name = value.replace(/[\W_]+/g, '_').replace(/^(\d)/, '_$1');
        return value;
      }
    },
    description: {
      message: 'Description',
      default: 'The best project ever.'
    },
    version: {
      message: 'Version',
      default: function(data, done) {
        task.helper('child_process', {
          cmd: 'git',
          args: ['describe', '--tags']
        }, function(err, result) {
          if (result) {
            result = result.split('-')[0];
          }
          done(null, semver.valid(result) || '0.1.0');
        });
      },
      validator: semver.valid,
      warning: 'Must be a valid semantic version.'
    },
    homepage: {
      message: 'Project homepage',
      default: function(data, done) {
        task.helper('property_git_origin', function(err, result) {
          if (!err) {
            result = result.replace(/\.git$/, '')
              .replace(/^git@(github.com):/, 'https://$1/');
          }
          done(null, result);
        });
      }
    },
    repository: {
      message: 'Project git repository',
      default: function(data, done) {
        task.helper('property_git_origin', function(err, result) {
          if (!err) {
            result = result.replace(/^git@(github.com):/, 'git://$1/');
          }
          done(null, result);
        });
      }
    },
    bugs: {
      message: 'Project issues tracker',
      default: function(data, done) {
        done(null, data.repository.replace(/^git/, 'https')
          .replace(/\.git$/, '/issues'));
      }
    },
    licenses: {
      message: 'Licenses',
      default: 'MIT',
      validator: /^[\w\-]+(?:\s+[\w\-]+)*$/,
      warning: 'Must be one or more space-separated licenses. (eg. ' +
        availableLicenses().join(' ') + ')',
      sanitize: function(value) { return value.split(/\s+/); }
    },
    author_name: {
      message: 'Author name',
      default: function(data, done) {
        task.helper('child_process', {
          cmd: 'git',
          args: ['config', '--get', 'user.name'],
          fallback: 'none'
        }, done);
      }
    },
    author_email: {
      message: 'Author email',
      default: function(data, done) {
        task.helper('child_process', {
          cmd: 'git',
          args: ['config', '--get', 'user.email'],
          fallback: 'none'
        }, done);
      }
    },
    author_url: {
      message: 'Author url',
      default: 'none'
    },
    node_version: {
      message: 'What versions of node does it run on?',
      default: '>= ' + process.versions.node
    },
    node_main: {
      message: 'Main module/entry point',
      default: function(data, done) {
        done(null, 'lib/' + data.name);
      }
    },
    node_test: {
      message: 'Test command',
      default: 'grunt test'
    }
  };

  var result = underscore.clone(properties[name]);
  result.name = name;
  if (arguments.length === 2) {
    result.default = alternateDefault;
  }
  return result;
});

// Get the git origin url from the current repo (if possible).
task.registerHelper('property_git_origin', function(done) {
  task.helper('child_process', {
    cmd: 'git',
    args: ['remote', '-v']
  }, function(err, result) {
    var re = /^origin/;
    if (err || !result) {
      done(true, 'none');
    } else {
      result = result.split('\n').filter(re.test.bind(re))[0];
      done(null, result.split(/\s/)[1]);
    }
  });
});

// An array of all available license files.
function availableLicenses() {
  var licensespath = file.extraspath('init/licenses');
  return fs.readdirSync(licensespath).map(function(filename) {
    return filename.replace(/^LICENSE-/, '');
  });
}

// Get user-specified init defaults (if they exist).
function initDefaults() {
  var defaults = file.userpath('init/defaults.json');
  return path.existsSync(defaults) ? file.readJson(defaults) : {};
}