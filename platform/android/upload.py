#!/usr/bin/python
#
# use python 2
#
#
# Copyright 2014 Google Inc. All Rights Reserved.
#
# Licensed under the Apache License, Version 2.0 (the 'License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#      http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

"""Uploads an Android App Bundle to the internal test track."""

import argparse
import sys
from apiclient import sample_tools
from oauth2client import client
import mimetypes
mimetypes.add_type('application/octet-stream', '.aab')

TRACK = 'internal'  # Can be 'internal', 'alpha', beta', 'production' or 'rollout'

# Declare command-line flags.
argparser = argparse.ArgumentParser(add_help=False)
argparser.add_argument('package_name',
                       help='The package name. Example: com.android.sample')
argparser.add_argument('aab_file',
                       help='The path to the .aab file to upload.')
argparser.add_argument('app_version',
                       help='x.x.x')


def main(argv):
  # Authenticate and construct service.
  service, flags = sample_tools.init(
      argv,
      'androidpublisher',
      'v3',
      __doc__,
      __file__, parents=[argparser],
      scope='https://www.googleapis.com/auth/androidpublisher')

  # Process flags and read their values.
  package_name = flags.package_name
  aab_file = flags.aab_file
  app_version = flags.app_version

  try:
    edit_request = service.edits().insert(body={}, packageName=package_name)
    result = edit_request.execute()
    edit_id = result['id']

    aab_response = service.edits().bundles().upload(
        editId=edit_id,
        packageName=package_name,
        media_body=aab_file).execute()

    print 'Version code %d has been uploaded' % aab_response['versionCode']

    track_response = service.edits().tracks().update(
        editId=edit_id,
        track=TRACK,
        packageName=package_name,
        body={u'releases': [{
            u'name': str(app_version),
            u'versionCodes': [str(aab_response['versionCode'])],
            u'status': u'completed',
        }]}).execute()

    print 'Track %s is set with releases: %s' % (
        track_response['track'], str(track_response['releases']))

    commit_request = service.edits().commit(
        editId=edit_id, packageName=package_name).execute()

    print 'Edit "%s" has been committed' % (commit_request['id'])

  except client.AccessTokenRefreshError:
    print ('The credentials have been revoked or expired, please re-run the '
           'application to re-authorize')

if __name__ == '__main__':
  main(sys.argv)




