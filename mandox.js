/**
 *                                __
 *                               /\ \
 *   ___ ___      __      ___    \_\ \    ___   __  _
 * /' __` __`\  /'__`\  /' _ `\  /'_` \  / __`\/\ \/'\
 * /\ \/\ \/\ \/\ \L\.\_/\ \/\ \/\ \L\ \/\ \L\ \/>  </
 * \ \_\ \_\ \_\ \__/.\_\ \_\ \_\ \___,_\ \____//\_/\_\
 *  \/_/\/_/\/_/\/__/\/_/\/_/\/_/\/__,_ /\/___/ \//\/_/
 *
 *
 * References
 * ----------
 *
 * Unlike languages like Java and Clojure, JavaScript does not have runtime
 * introspection facilities--except those thar are now  discouraged,
 * non-standard, deprecated or transient and removed.
 *
 * http://coachwei.sys-con.com/node/676031/mobile
 * http://jibbering.com/faq/notes/closures/
 * http://ramkulkarni.com/blog/getset-local-variables-of-javascript-function-from-outside-dynamic-code-insertion-in-js-function/
 * http://kangax.github.com/es5-compat-table/non-standard/
 * http://developer.longtailvideo.com/trac/browser/trunk/html5/lib/yuicompressor-2.4.2/src/com/yahoo/platform/yui/compressor/JavaScriptCompressor.java?rev=920#L464
 *
 * Usage
 * -----
 * eval(uate)('my-library.js')
 * mandox(obj)
 * mandox('jQuery.fn.jquery') // TODO
 */
(function __mandox__(global) {
	'use strict';

	var TRIM_WHITESPACE = /^\s+|\s+$/;
	var THIS_EXPRESSION = /^this\./;
	var LINE_BREAK = /[\r\n]/;
	var PREFIX_ASTERIX = /^\*\s?/g;
	var SIGNET = 'mandox';

	function dump(obj) {
		return JSON.stringify(obj, null, 4);
	}

	function to64(str) {
		return global.btoa(str);
	}

	function from64(str) {
		return global.atob(str);
	}

	function indexOf(needle, haystack) {
		var i;
		var len = haystack.length;
		for (i = 0; i < len; i++) {
			if (haystack[i] === needle) {
				return i;
			}
		}
		return -1;
	}

	function trim(str) {
		return str.replace(TRIM_WHITESPACE, '');
	}

	/**
	 * ['a', 1, 'c.d'] --> a["1"]["c.d"]
	 */
	function serialize(array, transform) {
		var i;
		var prop;
		var str = [];
		for (i = 0; i < array.length; i++) {
			prop = transform ? transform(array[i]) : array[i];
			str.push(str.length ? '["' + prop + '"]' : prop);
		}
		return str.join('');
	}

	/**
	 * a[1][2].b.c --> ["a", "1, "2", "b.c"]
	 */
	function tokenize(str, transform) {
		var pos;
		var chr;
		var token = [];
		var chain = [];
		for (pos = 0; pos < str.length; pos++) {
			chr = str[pos];
			if ('[' === chr || ']' === chr) {
				if (token.length) {
					chain.push(
						transform ? transform(token.join('')) : token.join('')
					);
					token.length = 0;
				}
			} else if (
				!(
					('"' === chr || "'" === chr)
					&&
					('[' === str[pos - 1] || ']' === str[pos + 1])
				) && (
					!('.' === chr && ']' === str[pos - 1])
				)
			) {
				token.push(chr);
			}
		}
		if (token.length) {
			chain.push(transform ? transform(token.join('')) : token.join(''));
		}
		return chain;
	}

	function decode(name) {
		return serialize(tokenize(name), from64);
	}

	var callstack = (function () {

		/**
		 * Must be able to match:
		 * " at Object.x.y (z) (script.js)"
		 * Generated from:
		 * x['y (z)'] = 1
		 */
		var FRAME_NAME = / at (?:(?:Object|Function)\.)?(.*) (?:.*?)$/;
		var SENTINAL_CALL_FRAME = / at mandox \(/;
		var AS_EXPRESSION = / \[as .*?$/;

		function parseProperty(str, pos) {
			var token = [str[pos++]];
			var chr;
			while (pos < str.length) {
				chr = str[pos++];
				if ('.' === chr) {
					break;
				}
				token.push(chr);
			}
			return token.join('');
		}

		// Cannot sanitize:
		// a['.b (c).d'] = 1
		// which yields:
		// a.b (c).d
		// so don't use crazy property names!
		function sanitizeCallFrameName(name) {
			name = name.replace(AS_EXPRESSION, '');
			var str = [];
			var pos = 0;
			var token;
			while (pos < name.length) {
				token = parseProperty(name, pos);
				pos += token.length + 1;
				if (str.length) {
					str.push('["' + to64(token) + '"]');
				} else {
					str.push(to64(token));
				}
			}
			return str.length ? str.join('') : to64(name);
		}

		function parseCallFrame(line) {
			var match = line.match(FRAME_NAME);
			return match && sanitizeCallFrameName(match[1]);
		}

		return function () {
			var stack = global.printStackTrace();
			var frames = [];
			var frame;
			var i;
			var start = false;
			for (i = 0; i < stack.length; i++) {
				if (start) {
					frame = parseCallFrame(stack[i]);
					if (frame) {
						frames.push(frame);
					}
				} else {
					start = SENTINAL_CALL_FRAME.test(stack[i]);
					// Because we need to skip
					//   "    at mandox (mandox.js:1:2)",
					//   "    at eval (eval at <anonymous> (foo.js:1:2), <anonymous>:3:4)",
					if (start) {
						i++;
					}
				}
			}
			return frames;
		};
	}());

	var parse = (function () {
		function getIdentifier(unit, path) {
			if (!unit) {
				return;
			}
			var prop;
			var chain;
			switch (unit.type) {
			case 'AssignmentExpression':
				return getIdentifier(unit.left, path);
			case 'Property':
				return getIdentifier(unit.key, path + '.');
			case 'MemberExpression':
				prop = getIdentifier(unit.property);
				chain = getIdentifier(unit.object, path);
				if (chain) {
					chain += '.';
				}
				break;
			case 'VariableDeclarator':
			case 'FunctionExpression':
			case 'FunctionDeclaration':
				return getIdentifier(unit.id, path);
			case 'Literal':
				prop = unit.value;
				chain = path;
				break;
			case 'Identifier':
				prop = unit.name;
				chain = path;
				break;
			case 'ThisExpression':
				return (path || '') + 'this';
			default:
				console.error(
					'(cannot resolve expression of type "' + unit.type +
						'": ' + path + ')'
				);
			}
			return prop && (chain || '') + prop;
		}

		function isArray(obj) {
			return (
				obj
				&& typeof obj === 'object'
				&& typeof obj.length !== 'undefined'
			);
		}

		/**
		 * Set of all possible code unit types that can be used to declare an
		 * identifier.
		 */
		var HAS_ID = {
			AssignmentExpression: true,
			FunctionDeclaration: true,
			FunctionExpression: true,
			Identifier: true,
			Property: true,
			VariableDeclarator: true
		};

		/*
		 * Expressions and statements.
		 * An expression is any valid unit of code that resolves to a value
		 *
		 * @see
		 * https://developer.mozilla.org/de/docs/JavaScript/Guide/Expressions_and_Operators
		 */
		var SUB_PROGRAM_PROPERTY = {
			AssignmentExpression: 'right',
			BlockStatement: 'body',
			Expression: 'expression',
			ExpressionStatement: 'expression',
			FunctionDeclaration: 'body',
			FunctionExpression: 'body',
			NewExpression: null,
			ObjectExpression: 'properties',
			Program: 'body',
			Property: 'value',
			SequenceExpression: 'expressions',
			VariableDeclaration: 'declarations',
			VariableDeclarator: 'init'
		};

		// https://developer.mozilla.org/en-US/docs/JavaScript/Reference/Functions_and_function_scope#Function_constructor_vs._function_declaration_vs._function_expression
		var IS_NEW_CONTEXT = {
			FunctionDeclaration: true,
			FunctionExpression: true
		};

		function getSubPrograms(unit) {
			var prop = SUB_PROGRAM_PROPERTY[unit.type];
			var body = prop && unit[prop];
			if (!body || 'Identifier' === body.type) {
				return [];
			}
			var units = isArray(body) ? body : [body];
			return IS_NEW_CONTEXT[unit.type] ? units.concat(unit.params)
			                                 : units;
		}

		// -1 == infinit depth
		var PARSE_DEPTH = -1;

		/**
		 * @see https://developer.mozilla.org/en-US/docs/SpiderMonkey/Parser_API
		 */
		function getSymbols(unit, path, ids, depth) {
			if (!ids) {
				ids = [];
			}
			if (typeof depth === 'undefined') {
				depth = PARSE_DEPTH;
			}
			var id = HAS_ID[unit.type] && getIdentifier(unit, path);
			var old;
			if (id && '_mandox_closure_' !== id) {
				ids.push({
					id: id,
					loc: unit.loc
				});
				old = path;
				path = id;
			}
			if (path && IS_NEW_CONTEXT[unit.type]) {
				path += '|';
				depth--;
			}
			if (0 === depth) {
				return ids;
			}
			var i;
			var units = getSubPrograms(unit);
			for (i = 0; i < units.length; i++) {
				getSymbols(
					units[i],
					(HAS_ID[unit.type] && (
						units[i].id || 'AssignmentExpression' === units[i].type
					)) ? old : path,
					ids,
					depth
				);
			}
			return ids;
		}

		var COLLECT_COMMENTS = {
			comment: true,
			loc: true
		};

		function getSyntaxTree(closure) {
			if (typeof closure !== 'function') {
				throw '(closure must be a typeof function)';
			}
			return global.esprima.parse(
				'var _mandox_closure_=' + String(closure),
				COLLECT_COMMENTS
			);
		}

		/**
		 * @param {function} closure
		 * @param {function(string):object} resolve ECMASpecification:
		 *		When control enters an execution context for eval code, the
		 *		previous active execution context, referred to as the calling
		 *		context, is used to determine the scope chain, the variable object,
		 *		and the this value.  If there is no calling context, then
		 *		initializing the scope chain, variable instantiation, and
		 *		determination of the this value are performed just as for global
		 *		code.
		 */
		return function (closure, resolve) {
			var syntax = getSyntaxTree(closure);
			if (!syntax) {
				return [];
			}
			var symbols = getSymbols(syntax);
			if (!symbols) {
				return [];
			}
			var len = symbols.length;
			var i;
			var id;
			for (i = 0; i < len; i++) {
				id = symbols[i];
				id.syntax = syntax;
				id.path = id.id.split('|');
			}
			return symbols;
		};
	}());

	function parseIdentifier(identifier, depth, frame) {
		var name = identifier.path[depth];
		if (THIS_EXPRESSION.test(name)) {
			if (depth > 0) {
				name = parseIdentifier(identifier, depth - 1, frame)
				     + '["' + name.replace(THIS_EXPRESSION, '') + '"]';
			} else if (frame) {
				var call = tokenize(frame, from64);
				name = serialize(call.slice(0, call.length - 1))
				     + '["' + name.replace(THIS_EXPRESSION, '') + '"]';
			} else {
				return null;
			}
		}
		return name;
	}

	function collectComment(comments, line) {
		var comment = comments[line];
		if ('Line' !== comment.type || 0 === line) {
			return comment.value;
		}
		var lines = '';
		var prev;
		do {
			lines = comment.value + '\n' + lines;
			prev = comment.loc.end.line;
			comment = comments[--line];
		} while ('Line' === comment.type && comment.loc.end.line === prev - 1);
		return lines;
	}

	function findComment(identifier, comments) {
		if (0 === comments.length) {
			return null;
		}
		var line = identifier.loc.start.line - 1;
		var max = comments.length;
		var min = 0;
		var mid;
		var diff;
		var oldMid;
		var comment;
		while (true) {
			mid = Math.floor(min + ((max - min) / 2));
			if (oldMid === mid) {
				return null;
			}
			diff = line - comments[mid].loc.end.line;
			if (0 === diff) {
				return collectComment(comments, mid);
			}
			if (1 > diff) {
				max = mid;
			} else {
				min = mid;
			}
			oldMid = mid;
		}
	}

	function getComment(identifier, out) {
		if (false === identifier.comment) {
			return;
		}
		if (!identifier.comment) {
			identifier.comment =
				findComment(identifier, identifier.syntax.comments) || false;
		}
		if (identifier.comment) {
			var longest = 0;
			var lines = identifier.comment.split(LINE_BREAK);
			var line;
			var comment = [];
			var i;
			var len = lines.length;
			var index;
			for (i = 0; i < len; i++) {
				line = lines[i];
				if (!('*' === line && (0 === i || len - 1 === i))) {
					index = comment.push(
						'  ' + line.replace(PREFIX_ASTERIX, '')
					);
					if (comment[index - 1].length > longest) {
						longest = comment[index - 1].length;
					}
				}
			}
			var title = SIGNET;
			var namespace = out().namespace;
			if (namespace) {
				title += ': ' + namespace;
			}
			var dashes = new Array(
						Math.max(3, Math.floor((longest - title.length) / 2))
					).join('-');
			comment.unshift(dashes + ' ' + title + ' ' + dashes, '');
			comment.push('', dashes + ' /' + title + ' ' + dashes);
			return comment.join('\n');
		}
		return;
	}

	function isInScopeChain(identifier, thisValue, resolve) {
		return thisValue === resolve(identifier.split('.')[0]);
	}

	function searchSymbols(entity, symbols, resolve, frame) {
		var identifier;
		var depth;
		var obj;
		var id;
		var i;
		var len = symbols.length;
		var thisValue = resolve('this');
		var expectsFreeVar = false;
		for (i = 0; i < len; i++) {
			id = symbols[i];
			expectsFreeVar = false;
			for (depth = 0; depth < id.path.length; depth++) {
				if (expectsFreeVar && THIS_EXPRESSION.test(id.path[depth])) {
					depth = id.path.length;
				} else {
					identifier = parseIdentifier(id, depth, frame);

					if (expectsFreeVar
							&& isInScopeChain(identifier, thisValue, resolve)) {
						expectsFreeVar = false;
					}

					// TODO: Consider instanceof relation
					obj = resolve(identifier);

					if (typeof obj === 'undefined') {
						expectsFreeVar = true;
					} else if (expectsFreeVar && (obj !== thisValue)) {
						depth = id.path.length;
					} else if (obj === entity) {
						return symbols[i];
					}
				}
			}
		}
	}

	function searchClosure(value, closure, resolve, frame) {
		return searchSymbols(value, parse(closure, resolve), resolve, frame);
	}

	function searchStack(value, frames, resolve) {
		var identifier;
		var closure;
		var len = frames.length;
		var i;
		for (i = 0; i < len; i++) {
			closure = resolve(decode(frames[i]));
			if (typeof closure === 'function') {
				identifier = searchClosure(value, closure, resolve, frames[i]);
				if (identifier) {
					return identifier;
				}
			}
		}
	}

	var unevaluated = [];
	var evaluated = [];
	var contexts = [];

	function searchContexts(value, contexts, out) {
		var identifier;
		var len = contexts.length;
		var i;
		for (i = 0; i < len; i++) {
			identifier = searchSymbols(
				value,
				contexts[i],
				contexts[i].__resolve__
			);
			if (identifier) {
				out(contexts[i].__resolve__);
				return identifier;
			}
		}
	}

	function findIdentifierByValue(value, out) {
		var identifier = searchContexts(value, contexts, out);
		var symbols;
		var closure;
		while (!identifier && unevaluated.length) {
			closure = unevaluated.pop();
			evaluated.push(closure);
			symbols = parse(closure);
			symbols.__resolve__ = closure.__resolve__;
			contexts.push(symbols);
			identifier = searchContexts(value, [symbols], out);
		}
		return identifier;
	}

	function findIdentifierByString(str, out) {
		return null;
	}

	function isTooPrimitive(type) {
		switch (type) {
		case 'boolean':
		case 'number':
			return true;
		default:
			return false;
		}
	}

	function outparam() {
		var value;
		return function () {
			if (arguments.length) {
				value = arguments[0];
			}
			return value;
		};
	}

	/**
	 *                                __
	 *                               /\ \
	 *   ___ ___      __      ___    \_\ \    ___   __  _
	 * /' __` __`\  /'__`\  /' _ `\  /'_` \  / __`\/\ \/'\
	 * /\ \/\ \/\ \/\ \L\.\_/\ \/\ \/\ \L\ \/\ \L\ \/>  </
	 * \ \_\ \_\ \_\ \__/.\_\ \_\ \_\ \___,_\ \____//\_/\_\
	 *  \/_/\/_/\/_/\/__/\/_/\/_/\/_/\/__,_ /\/___/ \//\/_/
	 *
	 * USAGE
	 * -----
	 * eval(uate)('my-library.js')
	 * mandox(obj)
	 * mandox('jQuery.fn.jquery') // TODO
	 */
	function mandox(value, resolve) {
		if (resolve) {
			var frames = callstack();
			var closure;
			var i;
			for (i = 0; i < frames.length; i++) {
				closure = resolve(decode(frames[i]));
				if (typeof closure !== 'function') {
					return '(mandox can only parse closures)';
				}
				if (closure
						&& indexOf(closure, evaluated) === -1
							&& indexOf(closure, unevaluated) === -1) {
					resolve.namespace = value;
					closure.__resolve__ = resolve;
					unevaluated.push(closure);
				}
			}
		} else {
			var type = typeof value;
			if ('undefined' === type || null === value || isTooPrimitive(type)) {
				return '(mandox cannot resolve symbols for ' + type + ')';
			}
			var out = outparam();
			var identifier = ('string' === type)
			               ? findIdentifierByString(value, out)
			               : findIdentifierByValue(value, out);
			return (identifier
				? (getComment(identifier, out) || '(no doc found for symbol)')
				: '(cannot resolve symbol)'
			);
		}
	}

	function macro() {
		var resolve = function (identifier) {
			try { return eval(identifier); } catch (e) {}
		};
		return function (closure) {
			return mandox(closure, resolve);
		};
	}

	global.uate = '(' + String(macro) + ').call(mandox)';
	global.mandox = mandox;
	global.__ = contexts;

	eval(global.uate)('mandox.js');

}(window));
