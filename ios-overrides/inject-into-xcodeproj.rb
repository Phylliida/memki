# Add our custom Swift files to the Xcode project so xcodebuild
# compiles them. Uses the `xcodeproj` gem (CocoaPods ships it).
#
# Idempotent — checks whether the file refs exist before adding.
#
# Derived from self-hosted-creature-collect/ios-overrides/inject-into-
# xcodeproj.rb, minus the keyboard-extension target (memki has no appex).

require 'xcodeproj'

PROJECT_PATH = 'ios/App/App.xcodeproj'
APP_GROUP = 'App'  # the source-file group inside the project
TARGET = 'App'     # the build target
NEW_FILES = ['SaveFolderPlugin.swift']

project = Xcodeproj::Project.open(PROJECT_PATH)

target = project.targets.find { |t| t.name == TARGET }
abort("ERROR: target #{TARGET} not found") unless target

group = project.main_group[APP_GROUP]
abort("ERROR: group #{APP_GROUP} not found") unless group

added = 0
NEW_FILES.each do |fname|
  if group.files.any? { |f| f.path == fname || f.display_name == fname }
    puts "  skip: #{fname} already in project"
    next
  end
  ref = group.new_reference(fname)
  target.source_build_phase.add_file_reference(ref)
  added += 1
  puts "  added: #{fname}"
end

if added > 0
  project.save
  puts "Saved #{PROJECT_PATH} with #{added} new file(s)"
else
  puts "No changes needed"
end

# Ensure `public` is a *folder reference* (lastKnownFileType=folder)
# rather than a *group*. Capacitor 6's iOS template should add it as a
# folder reference, but creature-collect observed builds where it ends
# up as a group — the visible symptom is that top-level webDir files
# bundle correctly, but anything in a subdirectory (e.g.
# /vendor/mathjax/output/chtml/fonts/woff-v2/*.woff) silently drops out
# of the .app. We rebuild the reference to be sure.
puts ""
puts "── verifying public folder reference ──"
existing = group.children.select do |c|
  (c.respond_to?(:path) && c.path == 'public') ||
  (c.respond_to?(:name) && c.display_name == 'public')
end
public_ref = nil
existing.each do |c|
  if c.is_a?(Xcodeproj::Project::Object::PBXFileReference) &&
     c.last_known_file_type == 'folder'
    puts "  found correct folder reference for public — leaving as-is"
    public_ref = c
  else
    puts "  removing public ref of wrong type: #{c.class}"
    target.resources_build_phase.files.dup.each do |bf|
      target.resources_build_phase.remove_build_file(bf) if bf.file_ref == c
    end
    c.remove_from_project
  end
end
unless public_ref
  puts "  adding public as a folder reference"
  ref = group.new_reference('public')
  ref.last_known_file_type = 'folder'
  ref.source_tree = '<group>'
  target.resources_build_phase.add_file_reference(ref)
  public_ref = ref
end

project.save
puts "Saved #{PROJECT_PATH}"
