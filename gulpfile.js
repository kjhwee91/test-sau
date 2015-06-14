var gulp = require('gulp');
var uglify = require('gulp-uglifyjs');
var concat = require('gulp-concat');
var fs = require('fs');
var glob = require('glob');
var rename = require('gulp-rename');
var _ = require('underscore');
var browserSync = require('browser-sync');
var path = require('path');
var header = require('gulp-header');
var jshint = require('gulp-jshint');
var karma = require('karma').server;
var jsdoc = require("gulp-jsdoc");
var clean = require('gulp-clean');
var sftp = require('gulp-sftp');
var prompt = require('gulp-prompt');
var gutil = require('gulp-util');
//var gulpsync = require('gulp-sync')(gulp);
var mkdirp = require('mkdirp');
var SSH2Utils = require('ssh2-utils');
var moment = require('moment');
var row2arr = require('row2arr');
var crawler = require("crawler");
var htmlparser = require("htmlparser");

// Develop Tasks
gulp.task('bs', function () {
	browserSync({
		host: "dev.search.naver.com",
		server: {
			baseDir: "./"
		},
		startPath: "__index.html",
		open: "external"
	});

	gulp.watch("./demo/**/*.html", browserSync.reload);
	gulp.watch("./src/**/*.js", ['build', browserSync.reload]);
});

gulp.task('default', ['nx_load','build', 'bs']);

// Build Tasks
gulp.task('build', ['lint'], function () {
	// build내부의 리스트 파일을 읽어와서 각각의 파일명으로 머지 처리
	glob('./release/build/*.list', function (er, files) {
		_.each(files, function (file, index, arr) {
			var outFileName = path.basename(file).replace(/\.list$/, ".merged.js");

			var arr = row2arr.readRow2ArrSync(file);

			try {
				_.each(arr, function (file) {
					// 빈 공백이 들어가 있을 경우 무시하기
					if (file.length === 0) {
						return;
					}

					var existsFile = fs.existsSync(file);

					if (existsFile === false) {
						throw new Error(gutil.colors.red("ENOENT") + " - " + file + " not found");
					}
				});

				// release date generate
				var currentDate = new Date().toISOString().replace(/T/, ' ').replace(/\..+/, '').split(' ')[0];
				var releaseDateText = ["/* release date : ", currentDate, " */\n"].join("");

				gulp.src(arr)
					.pipe(concat(outFileName))
					.pipe(gulp.dest('./release'))
					.pipe(uglify({
						compress: {
							warnings: false
						}
					}))
					.on("error", function (e) {
						console.log(gutil.colors.red(e));
					})
					.pipe(rename(function (path) {
						path.basename = path.basename.replace(".merged", "");
					}))
					// add release date
					.pipe(header(releaseDateText))
					.pipe(gulp.dest('./release'));

			} catch (e) {
				console.error(e);
			}
		});
	});
});

gulp.task('karma', function (done) {
	karma.start({
		configFile: __dirname + '/karma.conf.js',
		singleRun: false
	}, done);
});

gulp.task('lint', function () {
	gulp.src('jshint-output.html')
		.pipe(clean({force: true}));

	return gulp.src('./src/**/*.js')
		.pipe(jshint())
		.pipe(jshint.reporter('gulp-jshint-html-reporter', {
			filename: __dirname + '/jshint-output.html'
		}));
});

gulp.task('jsdoc', function () {
	return gulp.src(["./src/**/*.js", "README.md"])
		.pipe(jsdoc('./jsdoc'));
});


/**
 * SFTP 업로드 관련 태스크 영역
 **/
var currDirName = path.basename(__dirname);

var sshConfig = {
	"host": "localhost", // sstatic-ftp.naver.com
	"auth": "local",
	"remotePath": path.join("/Users/Naver/sftp/m", currDirName), // /s/mobile/_search/bestseller
	"port": 22 // 21022
};

// production
if (gutil.env.production === true) {
	sshConfig = {
		"host": "sstatic-ftp.naver.com",
		"auth": "sstatic",
		"remotePath": path.join("/m", currDirName),
		"port": 21022
	}
}

// 업로드 환경 셋팅
function _configFtpEnv() {
	var sshConfig = getSSHConfig();

	return new Promise(function (resolve) {
		gulp.src("*", {read: false})
			.pipe(prompt.prompt([
				{
					type: 'input',
					name: 'host',
					message: 'Please Check FTP Server Host: ',
					default: sshConfig.host
				},
				{
					type: 'input',
					name: 'port',
					message: 'Please Check FTP Server Port: ',
					default: sshConfig.port
				},
				{
					type: 'input',
					name: 'auth',
					message: 'Please Check .ftppass config file: ',
					default: sshConfig.auth
				},
				{
					type: 'input',
					name: 'remotePath',
					message: 'Please Check upload remotePath: ',
					default: sshConfig.remotePath
				}
			], function (res) {
				setSSHConfig({
					host: res.host,
					port: res.port,
					auth: res.auth,
					remotePath: res.remotePath
				});

				resolve();
			}));
	});
};


function setSSHConfig(config) {
	sshConfig = _.extend({}, sshConfig, config);
}

function getSSHConfig() {
	return sshConfig;
}

function checkExistsRemoteFile(remoteFilePath, cb) {

	var config = getSSHConfig();
	var htAccountInfo = getReadAccountInfo();

	// local
	config = _.extend({}, config, {
		username: htAccountInfo.sstatic.username,
		password: htAccountInfo.sstatic.password
	});

	var ssh = new SSH2Utils();

	ssh.fileExists(config, remoteFilePath, function (err, exists, server, conn) {
		if (err) {
			cb(false, err);
		} else {
			cb(true)
		}
		conn.end();
	});
}

function parsePath(filepath) {
	var extname = path.extname(filepath);
	return {
		dirname: path.dirname(filepath),
		basename: path.basename(filepath, extname),
		extname: extname
	};
}

function moveReleaseFileName(remoteFile, cb) {
	// 리모트에 해당 파일이 있는지 체크
	checkExistsRemoteFile(remoteFile, function (bIsExistFile) {
		if (bIsExistFile === true) {
			// 이미 있는 파일일 경우 새로운 파일명 만들어서 재귀호출
			var newRemoteFile = renameIncreaseHotfixCount(remoteFile);
			moveReleaseFileName(newRemoteFile, cb);
		} else {
			cb(path.basename(remoteFile));
		}
	});
}

function renameIncreaseHotfixCount(filepath) {
	var pathObject = parsePath(filepath);

	var hasHotfixCount = pathObject.basename.match(/_[0-9]{1,2}$/ig);

	// 핫픽스 카운트가 없을 경우 1 붙여줌
	if (!hasHotfixCount) {
		pathObject.basename += "_1";
	} else {
		// 핫픽스 카운트가 이미 있을 경우 +1씩 증가
		var hotfixCount = parseInt(pathObject.basename.match(/_([0-9]{1,2}$)/)[1], 10) + 1;

		pathObject.basename = pathObject.basename.replace(/_([0-9]{1,2}$)/, "_" + hotfixCount);
	}

	return pathObject.dirname + "/" + pathObject.basename + pathObject.extname;
}

function _uploadClean() {
	gulp.src("./release/upload/*.js")
		.pipe(clean({force: true}));
}


//
function _beforeReleaseFileCheck() {
	var config = getSSHConfig();
	var currentDate = moment().format("YYMMDD");
	var remotePath = config.remotePath;

	mkdirp.sync("./release/upload");

	return new Promise(function (resolve) {
		glob("./release/*.js", function (er, files) {
			_.each(files, function (file) {
				var renameObject = parsePath(file);

				var releaseFileName = renameObject.basename + "_" + currentDate + renameObject.extname;

				// filter merged file
				if (/^.+merged.+.js/.test(releaseFileName) === true) {
					return false;
				}

				moveReleaseFileName(path.join(remotePath, releaseFileName), function (releaseFileName) {
					// 해당 파일명이 sftp 에 없으면 upload 디렉토리로 복사 해두기
					fs.createReadStream(file).pipe(fs.createWriteStream("./release/upload/" + releaseFileName));
				});
			});

			resolve();
		});
	});
};

// 계정 정보 입력받기
function promptAccountInfo() {
	return new Promise(function (resolve, reject) {
		gulp.src("*", {read: false})
			.pipe(prompt.prompt([
				{
					type: 'input',
					name: 'username',
					message: 'Please input username: '
				},
				{
					type: 'input',
					name: 'password',
					message: 'Please input password: '
				}
			], function (promptObject) {
				resolve(promptObject);
			}));
	});
};

// 계정 정보 변수 셋팅 & 파일 저장
function setAccountInfo(res, done) {
	if (!res.username && !res.password) {
		return false;
	}

	var htInput = {
		username: res.username,
		password: res.password
	};

	writeAccountInfo(htInput);
	setSSHConfig(htInput);

	done();
};

function getReadAccountInfo() {
	var sTargetPath = process.env.HOME + "/.sau/";
	var sAccountFileName = ".ftppass";
	var sAccountFilePath = path.join(sTargetPath, sAccountFileName);

	return JSON.parse(fs.readFileSync(sAccountFilePath, {
		encoding: "utf-8"
	}));
}


// 계정정보 파일 저장
function writeAccountInfo(htInput) {
	var sTargetPath = process.env.HOME + "/.sau/"; // 윈도우에서 홈 디렉토리 얻을 수 있도록 수정하기
	var sFileName = ".ftppass";
	var oSet = {
		"sstatic": {
			"username": htInput.username,
			"password": htInput.password
		}
	};

	mkdirp(sTargetPath, function (err) {
		fs.writeFile(sTargetPath + sFileName, JSON.stringify(oSet), "utf8", function (err) {
			console.log("account save success");
		});
	});
};

// 사용자 계정 입력받는 task
gulp.task('reset_ftp', function (done) {
	var promise = promptAccountInfo();

	promise.then(function (promptObject) {
		setAccountInfo(promptObject, function () {
			done();
		});
	});
});

// 사용자 계정 입력 받은 후 파일 생성하는 task
function _generate_account_info_file() {

	return new Promise(function (resolve) {
		var sTargetPath = path.join(process.env.HOME, ".sau"); // 윈도우에서 홈 디렉토리 얻을 수 있도록 수정하기
		var sFilePath = path.join(sTargetPath, ".ftppass");

		fs.readFile(sFilePath, "utf-8", function (err, data) {
			var bNoFile = err !== null && err.code === "ENOENT";

			if (bNoFile) { // 계정 파일이 없는 경우
				var promise = promptAccountInfo();

				promise.then(function (promptObject) {
					setAccountInfo(promptObject, done);
				});
			} else { // 계정 파일이 존재하는 경우
				var oAuthData = JSON.parse(data);
				setSSHConfig({
					username: oAuthData.sstatic.username,
					password: oAuthData.sstatic.password
				});
			}

			resolve();
		})
	});
};


// 입력받은 계정 정보로 파일 업로드
gulp.task('release', ['build'], function () {
	var promise = null;
	_uploadClean();
	promise = _generate_account_info_file();

	promise
		.then(_beforeReleaseFileCheck)
		.then(_configFtpEnv)
		.then(function () {
			var sshConfig = getSSHConfig();

			var releaseFileList = gulp.src(["./release/upload/*.js"]);
			var files = glob.sync("./release/upload/*.js");

			console.log("/****** Config FTP Upload Status ******/");
			console.log("Target Server: ", sshConfig.host);
			console.log("Target Server Port: ", sshConfig.port);
			console.log("Upload Path: ", sshConfig.remotePath);
			console.log("Upload File List: ", "\n" + files.join("\n"));
			console.log("/**************************************/");

			releaseFileList
				.pipe(prompt.confirm({
					message: 'Upload Now?',
					default: false
				}))
				.pipe(sftp(sshConfig))
				.pipe(clean({force: true}))
		})
});









//var gulp = require('gulp');
//var uglify = require('gulp-uglifyjs');
//var concat = require('gulp-concat');
//var fs = require('fs');
//var glob = require('glob');
//var rename = require('gulp-rename');
//var _ = require('underscore');
//var browserSync = require('browser-sync');
//var path = require('path');
//var header = require('gulp-header');
//var jshint = require('gulp-jshint');
//var karma = require('karma').server;
//var jsdoc = require("gulp-jsdoc");
//var clean = require('gulp-clean');
//var sftp = require('gulp-sftp');
//var prompt = require('gulp-prompt');
//var gutil = require('gulp-util');
////var gulpsync = require('gulp-sync')(gulp);
//var mkdirp = require('mkdirp');
//var SSH2Utils = require('ssh2-utils');
//var moment = require('moment');
//var row2arr = require('row2arr');
//var crawler = require("crawler");
//var htmlparser = require("htmlparser");






var async = require('async');

gulp.task('nx_load', function(){
	fs.readFile('.nx_load', function(err, data){
		if(err){
			initialNxFile();
		} else {
			// data 에서 nx url 가져오기
			checkNxVersion(JSON.parse(data.toString()));
		}
	});
});

function checkNxVersion(htNxData){
	crawlingNxFile(function(err, sCrawledNx){
		if(htNxData.sNxFile !== sCrawledNx){
			initialNxFile();
			return ;
		}
		var htDemoFile = htNxData.htFile;
		fs.readdir('demo/', function(err, files){
			var newestNx = [];
			var oldNx = [];
			files.forEach(function(file){
				if(htDemoFile[file].sNxUrl === sCrawledNx){
					newestNx.push(sCrawledNx);
				} else {
					oldNx.push(sCrawledNx);
				}
			});
			updateNxFile(newestNx, oldNx, sCrawledNx);
		});
	});
};

function updateNxFile(aNewestNx, aOldNx, sCrawledNx){
	insertNxFile(aOldNx, sCrawledNx, function(aResult){
		var aNxInsertedFile = aResult.map(function(v){
			return {'sFileName' : v.file, 'sNxUrl' : sCrawledNx};
		});
		aNewestNx.map(function(file){
			aNxInsertedFile.push({'sFileName' : 'demo/'+file, 'sNxUrl' : sCrawledNx});
		});
		var htDemoFile = {};
		aNxInsertedFile.forEach(function(v){
			htDemoFile[v.sFileName] = {'sNxUrl' : v.sNxUrl};
		});
		setNxDataFile({'sNxUrl' : sCrawledNx, 'htFile' : htDemoFile});
	});
};

function initialNxFile(){
	var sCrawledNx = "";
	var exsistNx = [];

	async.waterfall([
		function(callback){
			crawlingNxFile(callback);
		},
		// demo 에서 nx 있는지 확인하기
		function(sNxFile, callback){
			sCrawledNx = sNxFile;
			fs.readdir('demo/', function(err, files){
				var aFnParallel = files.map(function(sFile){
					return checkNxInDemoFile.bind(null, sFile);
				});
				async.parallel(aFnParallel,function(err, result){
					callback(null, result, sNxFile);
				});
			});
		},
		function(aResults, sNxFile, callback){
			var noNx = [];
			aResults.forEach(function(htResult){
				if(htResult.isExist && htResult.sNxUrl === sNxFile){
					exsistNx.push(htResult.file);
				} else {
					noNx.push(htResult.file);
				}
			});
			insertNxFile(noNx, sNxFile, callback);
		},
		function(aResult){
			var aNxInsertedFile = aResult.map(function(v){
				return {'sFileName' : v.file, 'sNxUrl' : sCrawledNx};
			});
			exsistNx.map(function(file){
				aNxInsertedFile.push({'sFileName' : 'demo/'+file, 'sNxUrl' : sCrawledNx});
			});
			var htDemoFile = {};
			aNxInsertedFile.forEach(function(v){
				htDemoFile[v.sFileName] = {'sNxUrl' : v.sNxUrl};
			});
			setNxDataFile({'sNxUrl' : sCrawledNx, 'htFile' : htDemoFile});
		}
	]);
};

function setNxDataFile(data){
	fs.writeFile('.nx_load', JSON.stringify(data));
}

function insertNxFile(targetFileList, sNxUrl, callback){
	var aFnParallel = targetFileList.map(function(target){
		return function(demoFile, nextCallback){
			var buffer = new Buffer('\<script type\=\"text\/javascript\" src=\"' + sNxUrl + '\">\<\/script\>\n');
			fs.readFile(demoFile, function(err, bf){
				var html = bf.toString();
				var offset = html.indexOf('</head>');
				var bodyBuffer = new Buffer(html.substring(offset));
				var writeStream = fs.createWriteStream(demoFile,{flags: 'r+', mode: 0777, start: offset});
				writeStream.write(buffer + bodyBuffer, function(err){
					if(err){
						nextCallback(null, {"file" : demoFile, "isSuccess" : false});
					} else {
						nextCallback(null, {"file" : demoFile, "isSuccess" : true});
					}
				});
			});
		}.bind(null, 'demo/'+target);
	});
	async.parallel(aFnParallel,function(err, result){
		callback(null, result);
	});
};

function crawlingNxFile(callback){
	new crawler({
		"forceUTF8" : true,
		"callback" : function (error, sCrawlerResult) {
			if(error){
				console.error("cannot get recent nx file");
			} else {
				// 네이버 검색 결과에서 크롤링한 html 에서 최신 nx 파일 추출
				var body = sCrawlerResult.body;
				var urlReg = /\/\/m.search.naver.com\/acao\/js\/\d+\/nx_\d+.js/g
				var nx_file = "https:" + body.match(urlReg)[0];
				callback(null, nx_file);
			}
		}
	}).queue([{
		uri: 'https://m.search.naver.com/search.naver?where=m&sm=mtp_lve&query=test',
	}]);
};

function checkNxInDemoFile(demoFile, nextCallback){
	fs.readFile('demo/' + demoFile, function (error, html) {
		if (!error) {
			var header = html.toString().match(/<head>(?:.|\n|\r)+?<\/head>/g)[0].replace('<head>', '').replace('</head>', '');
			var parser = new htmlparser.Parser(new htmlparser.DefaultHandler(function (error, aDom) {
				if (!error) {
					var isExist = false;
					var sNx = null;
					aDom.forEach(function (htDom) {
						if (htDom.name === 'script' && htDom.attribs.type === 'text/javascript') {
							var urlReg = /https:\/\/m.search.naver.com\/acao\/js\/\d+\/nx_\d+.js/g;
							var aMatch = htDom.attribs.src.match(urlReg);
							if (aMatch !== null && aMatch.length > 0) {
								isExist = true;
								sNx = aMatch[0];
							}
						}
					});
					var htResult = {};
					htResult.file = demoFile;
					htResult.isExist = isExist;
					htResult.sNxUrl = sNx;
					nextCallback(null, htResult);
				}
			}, {
				ignoreWhitespace: true
			}));
			parser.parseComplete(header);
		}
	});
};