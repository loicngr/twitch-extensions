import { State } from '../common/state'
import { bexBackground } from 'quasar/wrappers'
import {
  ALARM_API_FETCH_INTERVAL,
  ALARM_FETCH_INIT_KEY,
  NOTIFICATION_STREAM_START
} from '../common/consts'
import { getTwitchCurrentUser } from '../common/api'
import {
  extractTokenFromUrl,
  getFullUsersOnStreams,
  getTwitchOauthUrl,
  playSound,
  removeAllNotifications,
  setupOffscreenDocument
} from '../common/utils'

let initCount = 0

async function notificationOnStream (options = {}, userStream) {
  await chrome.notifications.create(
    `${NOTIFICATION_STREAM_START}-${userStream.user_login}`,
    {
      title: userStream.user_name,
      iconUrl: chrome.runtime.getURL('src/assets/logo.jpg'),
      message: '',
      type: 'basic',
      priority: 2,
      isClickable: true,
      ...options
    },
    () => {
      playSound()
    }
  )
}

async function openTwitchOauth () {
  const url = getTwitchOauthUrl()
  if (url === false) {
    console.error('URL not valid')
    return false
  }

  return new Promise((resolve, reject) => {
    chrome.identity.launchWebAuthFlow({
      url,
      interactive: true
    }, async (flowRedirectUrl) => {
      if (typeof flowRedirectUrl === 'undefined') {
        return reject(false)
      }

      const accessToken = extractTokenFromUrl(flowRedirectUrl)
      State.accessToken = accessToken

      const user = await getTwitchCurrentUser(accessToken)
      if (user === null) {
        return reject(false)
      }

      resolve(true)
    })
  })
}

async function notify () {
  const usersData = await State.usersData
  const clonedUsersData = [...Object.values(usersData)]
  if (clonedUsersData.length === 0) {
    return
  }

  const usersNotNotify = clonedUsersData.filter((u) => u.notified === false)
  if (usersNotNotify.length === 0) {
    return
  }

  removeAllNotifications()

  // Add event listeners for new notification
  chrome.notifications.onClicked.addListener(async function (a) {
    if (a.startsWith(NOTIFICATION_STREAM_START)) {
      const userLogin = a.split('-')[1]
      await chrome.tabs.create({ url: `https://www.twitch.tv/${userLogin}` })
    }
  })

  const newUserStream = {}
  for (const userStream of usersNotNotify) {
    await notificationOnStream({
      message: userStream.title,
      iconUrl: userStream.thumbnail_url.replace('{width}', 100).replace('{height}', 60),
      contextMessage: `${userStream.game_name} (${userStream.viewer_count} viewers)`
    }, userStream)

    newUserStream[userStream.user_id] = {
      ...userStream,
      notified: true
    }
  }

  State.usersData = {
    ...usersData,
    ...newUserStream
  }
}

async function main () {
  initCount = 0
  await setupOffscreenDocument()

  const usersData = (await State.usersData) ?? {}
  const usersOnStream = await getFullUsersOnStreams()
  const clonedUsersData = {}

  await Promise.all(usersOnStream.map(async (userOnStream) => {
    const userStreamId = userOnStream.user_id
    const storedUserData = userStreamId in usersData && usersData[userStreamId].id === userOnStream.id
      ? usersData[userStreamId]
      : { notified: false }

    clonedUsersData[userStreamId] = {
      ...userOnStream,
      ...storedUserData
    }
  }))

  State.usersData = clonedUsersData
  await notify()
}

function handleTwitchOauth () {
  openTwitchOauth()
    .then(() => main())
    .catch(() => init())
}

async function init (accessToken) {
  initCount += 1

  if (initCount > 3) {
    console.error('loop init : ' + accessToken)
    return
  }

  const settings = await State.settings
  if (
    typeof settings === 'undefined' ||
    Object.keys(settings).length > 0
  ) {
    State.settings = {
      audio: true,
      ...settings
    }
  }

  if (typeof accessToken === 'undefined') {
    return handleTwitchOauth()
  }

  const userResponse = await getTwitchCurrentUser(accessToken)

  if (userResponse === null) {
    return handleTwitchOauth()
  }

  const alarmRunning = await chrome.alarms.get(ALARM_FETCH_INIT_KEY)
  if (!alarmRunning) {
    chrome.alarms.create(ALARM_FETCH_INIT_KEY, {
      periodInMinutes: ALARM_API_FETCH_INTERVAL
    })
  }

  await main()
}

State.accessToken
  .then(init)

export default bexBackground(() => {
  // TODO: use quasar bridge
})

chrome.alarms.onAlarm.addListener(async ({ name }) => {
  switch (name) {
    case ALARM_FETCH_INIT_KEY:
      State.accessToken
        .then(init)
      break
    default:
      break
  }
})

chrome.runtime.onMessage.addListener(async ({ type }) => {
  switch (type) {
    case 'reset':
      await main()
      break
    case 'reset-init':
      await init()
      break
    default:
      break
  }
})

chrome.runtime.onInstalled.addListener(() => {
  chrome.action.onClicked.addListener((/* tab */) => {
    chrome.tabs.create({
      url: chrome.runtime.getURL('www/index.html')
    }, () => {})
  })
})