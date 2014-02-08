var request = require('request')
  , fs = require('fs')
  , Q  = require('q')
  , sanitizeHtml = require('sanitize-html')
  , Evernote = require('evernote').Evernote
  , storyHash = {}
  , storyHashFile = "story.hash";

function collect() {
  var ret = {};
  var len = arguments.length;
  for (var i=0; i<len; i++) {
    for (p in arguments[i]) {
      if (arguments[i].hasOwnProperty(p)) {
        ret[p] = arguments[i][p];
      }
    }
  }
  return ret;
}

// Newsblur API
var OPTS  = {
      jar: true,
      headers: {
        'User-Agent': 'request'
      }
    };

var NB    = "http://newsblur.com",
    LOGIN = collect(OPTS, {
      url: NB + '/api/login',
      form: {username: process.env.NEWSBLUR_USERID, password: process.env.NEWSBLUR_PASSWORD}
    });

// Evernote API
var EVERNOTE_TOKEN = process.env.EVERNOTE_TOKEN,
    evernote_client = new Evernote.Client({token: EVERNOTE_TOKEN, sandbox : false}),
    noteStore = evernote_client.getNoteStore();

// Newsblur Authentication
function authenticate() {
  var deferred = Q.defer();
  request.post(LOGIN, function(e, res, body) {
    if (!e && res.statusCode == 200) {

      var j = {};
      try {
        j = JSON.parse(body);
      } catch(e) { deferred.reject(e) }

      if (j.hasOwnProperty('authenticated') && j.authenticated) {
        console.log('Authenticated to Newsblur.');
        deferred.resolve(true);
      } else {
        deferred.reject(new Error('Failed to authenticate: ' + body));
      }
    } else {
      deferred.reject(e)
    }
  })

  return deferred.promise;
}

function getStarred(p, o) {
  var deferred = Q.defer();

  // If called with a number fetch that page
  var page = p > 1 ? p : 1;
  // Pass along the promises representing stories from other pages or
  // an empty array if this is the first invocation
  var otherstories = o || [];

  console.log('Fetching page ' + page + ' from Newsblur. ' + otherstories.length + ' stories so far.');

  // Setup the URL
  var STARRED = collect(OPTS, {url: NB + '/reader/starred_stories?page=' + page});
  request(STARRED, function(e, res, body) {
    if (!e && res.statusCode == 200) {
      var newsblur = {};
      try {
        newsblur = JSON.parse(body);
      } catch(e) { deferred.reject(e)}

      if (newsblur.hasOwnProperty('stories') && newsblur.stories.length > 0) {
        // Filter out the old stories
        var total = newsblur.stories.length;
        newsblur.stories = newsblur.stories.filter(newStoryFilter);

        // Any left?
        console.log('Fetched ' + newsblur.stories.length + '/' + total + ' stories from Newsblur');

        // Maybe there are more? Return a promise to fetch more
        // TEMP -- to save the loads
        // deferred.resolve( newsblur.stories );
        deferred.resolve( getStarred(page+1, otherstories.concat(newsblur.stories)) );
      } else {
        // No more stories. Returns the ones we have so far
        deferred.resolve(otherstories);
      }
    } else {
      deferred.reject(e);
    }
  })

  return deferred.promise;
}

// Story Hashes
function loadStoryHashes() {
  console.log('Loading story hashes.');

  var contents = {};

  try {
    contents = JSON.parse(fs.readFileSync(storyHashFile));
  } catch(e) { contents = {} }

  storyHash = contents;
}

function newStoryFilter(story) {
  if (storyHash[story.story_hash]) {
    // Already uploaded
    return(false);
  } else {
    // New story!
    storyHash[story.story_hash] = true;
    return(true);
  }
}

function saveStoryHashes() {
  console.log('Saving story hashes.');
  fs.writeFileSync(storyHashFile, JSON.stringify(storyHash));
}

// Evernote
function saveStoryToEvernote(story) {
  var deferred = Q.defer();

  var nBody = "<?xml version=\"1.0\" encoding=\"UTF-8\"?>";
  nBody += "<!DOCTYPE en-note SYSTEM \"http://xml.evernote.com/pub/enml2.dtd\">";
  // nLink = '<a href="' + story.story_permalink + '">' + story.story_title + '</a><p/>';
  nBody += "<en-note>" + sanitizeHtml(story.story_content) + "</en-note>";
 
  // Create note object
  var ourNote = new Evernote.Note();
  ourNote.title = story.story_title;
  ourNote.content = nBody;
  ourNote.notebookGuid = notebookGUID;
  ourNote.tagNames = story.user_tags;

  // Attributes
  var noteAttributes = new Evernote.NoteAttributes();
  noteAttributes.sourceURL = story.story_permalink;
  noteAttributes.author = story.authors;
  noteAttributes.source = "Newsblur";
  ourNote.attributes = noteAttributes;

  // Attempt to create note in Evernote account
  noteStore.createNote(ourNote, function(err, note) {
    if (err) {
      // Something was wrong with the note data
      // See EDAMErrorCode enumeration for error code explanation
      // http://dev.evernote.com/documentation/reference/Errors.html#Enum_EDAMErrorCode
      deferred.reject(err);
    } else {
      console.log('Saved "' + story.story_title + '"');
      deferred.resolve(note);
    }
  }); 

  return(deferred.promise);
}

function uploadToEvernote(stories) {
  console.log('Upload to Evernote ' + stories.length + ' stories.');
  // Return a promise waiting on all that saving to finish
  return(Q.allSettled( stories.map(saveStoryToEvernote) ));
}

function getNewsblurNotebook() {
  var deferred = Q.defer();
  console.log('Getting Newsblur notebook GUID.');
  noteStore.listNotebooks(function(e, notebooks) {
    if (e) {
      deferred.reject(e);
    } else {
      var nb;
      try {
        nb = notebooks.filter(function(n) {
          return n.name == "Newsblur"
        })[0].guid;
      } catch(e) { deferred.reject(e) }
  
      // Return the notebook
      notebookGUID = nb;
      deferred.resolve(nb);
    }
  });
  return(deferred.promise);
}

var notebookGUID;

// Lets do this
Q.all([authenticate(), loadStoryHashes(), getNewsblurNotebook()])
  .then(getStarred)
  .then(uploadToEvernote)
  .finally(saveStoryHashes)
  .fail(console.log)
  .done();