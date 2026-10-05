# /// script
# requires-python = ">=3.10"
# dependencies = ["twifork"]
# ///
"""Twikit (twifork) CLI wrapper for browse.

The TypeScript side keeps parsing-only responsibilities, so this wrapper owns
every twikit call and speaks JSON on stdin/stdout. Login is done in the
camoufox browser by `browse login twitter`, which saves the flat {name: value}
cookie JSON this wrapper feeds to Client.load_cookies.

Subcommands:
  tweet <id> --cookie-file <path>            tweet + replies
  user <screen_name> --count N --cookie-file <path>
  search <query> --count N [--latest] --cookie-file <path>
"""

import argparse
import asyncio
import json
import os
import sys


def die(message: str) -> None:
    print(json.dumps({"error": message}), file=sys.stderr)
    sys.exit(1)


def build_client(cookie_file: str):
    from twikit import Client

    client = Client("en-US")
    if not os.path.exists(cookie_file):
        die(f"no twitter cookies found: {cookie_file}. run: browse login twitter")
    try:
        client.load_cookies(cookie_file)
    except Exception as error:  # noqa: BLE001 - report any cookie failure
        die(f"loading cookies failed: {error}")
    return client


def tweet_payload(tweet) -> dict:
    """Shape a twikit Tweet into the JSON the TS side renders."""
    user = getattr(tweet, "user", None)
    media_urls = []
    for media in getattr(tweet, "media", None) or []:
        url = getattr(media, "url", None)
        if url:
            media_urls.append(url)
    return {
        "id": str(getattr(tweet, "id", "") or ""),
        "text": getattr(tweet, "text", "") or "",
        "author": getattr(user, "name", None) if user else None,
        "screenName": getattr(user, "screen_name", None) if user else None,
        "createdAt": str(getattr(tweet, "created_at", "")) or None,
        "likes": getattr(tweet, "favorite_count", None),
        "retweets": getattr(tweet, "retweet_count", None),
        "replies": getattr(tweet, "reply_count", None),
        "mediaUrls": media_urls,
    }


def tweets_payload(tweets) -> list:
    return [tweet_payload(tweet) for tweet in tweets or []]


async def cmd_tweet(args) -> dict:
    client = build_client(args.cookie_file)
    tweet = await client.get_tweet_by_id(args.tweet_id)
    if tweet is None:
        die(f"tweet not available: {args.tweet_id}")
    replies = []
    raw_replies = getattr(tweet, "replies", None)
    if raw_replies is not None:
        replies = tweets_payload(raw_replies)
    return {"tweet": tweet_payload(tweet), "replies": replies}


async def cmd_user(args) -> dict:
    client = build_client(args.cookie_file)
    user = await client.get_user_by_screen_name(args.screen_name)
    if user is None or not getattr(user, "id", None):
        die(f"user not found: {args.screen_name}")
    tweets = await client.get_user_tweets(user.id, "Tweets", count=args.count)
    return {
        "userInfo": {"name": user.name, "screenName": user.screen_name},
        "tweets": tweets_payload(tweets),
    }


async def cmd_search(args) -> dict:
    client = build_client(args.cookie_file)
    product = "Latest" if args.latest else "Top"
    tweets = await client.search_tweet(args.query, product, count=args.count)
    return {"tweets": tweets_payload(tweets)}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)

    tweet_parser = subparsers.add_parser("tweet")
    tweet_parser.add_argument("tweet_id")
    tweet_parser.add_argument("--cookie-file", required=True)
    tweet_parser.set_defaults(func=cmd_tweet)

    user_parser = subparsers.add_parser("user")
    user_parser.add_argument("screen_name")
    user_parser.add_argument("--count", type=int, default=40)
    user_parser.add_argument("--cookie-file", required=True)
    user_parser.set_defaults(func=cmd_user)

    search_parser = subparsers.add_parser("search")
    search_parser.add_argument("query")
    # twifork search_tweet accepts 1-20 per page.
    search_parser.add_argument("--count", type=int, default=20)
    search_parser.add_argument("--latest", action="store_true")
    search_parser.add_argument("--cookie-file", required=True)
    search_parser.set_defaults(func=cmd_search)

    args = parser.parse_args()
    try:
        payload = asyncio.run(args.func(args))
    except SystemExit:
        raise
    except Exception as error:  # noqa: BLE001 - surface every wrapper failure
        die(f"{type(error).__name__}: {error}")
    print(json.dumps(payload))


if __name__ == "__main__":
    main()
